#!/usr/bin/env node
/*
 * start-tunnel.js — เปิด Cloudflare Quick Tunnel แล้วอัปเดต APP_URL ให้อัตโนมัติ
 *
 * ทำงาน: รัน cloudflared → ดึง URL trycloudflare.com → เขียนลง .env → recreate
 *         เฉพาะ container "app" เพื่อให้ลิงก์ที่ push หาลูกบ้านชี้มา URL ใหม่
 *
 * วิธีใช้ (รันที่เครื่อง host ไม่ใช่ใน docker):
 *     node start-tunnel.js
 *
 * ต้องมี: cloudflared, docker compose v2 อยู่ใน PATH
 * กด Ctrl+C เพื่อหยุด tunnel
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');
const PORT     = process.env.PORT || 3001;
const URL_RE   = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// หา cloudflared: กำหนดเองผ่าน env > ไฟล์ในโฟลเดอร์โปรเจค > ตำแหน่งติดตั้งทั่วไป > PATH
// (กันปัญหา terminal ยังไม่รีเฟรช PATH หลังเพิ่งติดตั้ง / ติดตั้งคนละที่)
//
// ถ้าเครื่องไหน cloudflared อยู่ที่แปลกๆ ตั้ง env ก่อนรันได้เลย เช่น:
//     set CLOUDFLARED_PATH=D:\tools\cloudflared.exe   (cmd)
//     $env:CLOUDFLARED_PATH="D:\tools\cloudflared.exe" (PowerShell)
function findCloudflared() {
    const candidates = [
        process.env.CLOUDFLARED_PATH,                       // กำหนดเอง
        path.join(__dirname, 'cloudflared.exe'),            // วางไว้ในโฟลเดอร์โปรเจค
        'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        'C:\\Program Files\\cloudflared\\cloudflared.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\cloudflared.exe'),
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return 'cloudflared'; // สุดท้ายลองจาก PATH
}
const CLOUDFLARED = findCloudflared();

let appliedUrl = null;

function updateEnvAppUrl(url) {
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (/^APP_URL=.*$/m.test(env)) {
        env = env.replace(/^APP_URL=.*$/m, `APP_URL=${url}`);
    } else {
        env = env.replace(/\s*$/, '') + `\nAPP_URL=${url}\n`;
    }
    fs.writeFileSync(ENV_PATH, env);
}

function recreateApp() {
    console.log('♻️  recreate container "app" เพื่อโหลด APP_URL ใหม่...');
    execSync('docker compose up -d --force-recreate --no-deps app', { stdio: 'inherit', cwd: __dirname });
}

console.log(`🚀 เปิด Cloudflare Quick Tunnel → http://localhost:${PORT}`);
console.log(`   ใช้ cloudflared: ${CLOUDFLARED}`);
const cf = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`]);

function onOutput(data) {
    const text = data.toString();
    process.stdout.write(text); // โชว์ log ของ cloudflared ตามปกติ
    const m = text.match(URL_RE);
    if (m && m[0] !== appliedUrl) {
        appliedUrl = m[0];
        console.log(`\n🌐 ได้ Tunnel URL: ${appliedUrl}`);
        try {
            updateEnvAppUrl(appliedUrl);
            console.log('✅ อัปเดต APP_URL ใน .env แล้ว');
            recreateApp();
            console.log(`✅ เสร็จ — ลิงก์ที่ push หาลูกบ้านจะชี้มา ${appliedUrl}\n`);
        } catch (e) {
            console.error('❌ อัปเดตไม่สำเร็จ:', e.message);
        }
    }
}

cf.stdout.on('data', onOutput);
cf.stderr.on('data', onOutput); // cloudflared พิมพ์ URL ออกทาง stderr

cf.on('error', (e) => console.error('❌ รัน cloudflared ไม่ได้ (อยู่ใน PATH ไหม?):', e.message));
cf.on('close', (code) => { console.log(`cloudflared ปิดแล้ว (code ${code})`); process.exit(code || 0); });

process.on('SIGINT', () => { console.log('\n🛑 หยุด tunnel'); cf.kill('SIGINT'); process.exit(0); });
