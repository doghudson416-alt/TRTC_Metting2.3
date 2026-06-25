require('dotenv').config(); // โหลดค่าตัวแปรจากไฟล์ .env มาใช้ในโปรเจกต์

const express = require('express'); // นำเข้า Express framework สำหรับสร้างเว็บเซิร์ฟเวอร์
const cors = require('cors'); // นำเข้า CORS middleware เพื่อจัดการกับ Cross-Origin Resource Sharing
const { Pool } = require('pg'); // นำเข้า Pool จาก pg library เพื่อเชื่อมต่อและจัดการกับฐานข้อมูล PostgreSQL
const TLSSigAPIv2 = require('tls-sig-api-v2'); // นำเข้า TLSSigAPIv2 สำหรับสร้าง User Signature ที่ใช้ในการยืนยันตัวตนกับ TRTC
const http = require('http'); // นำเข้า http module เพื่อสร้าง HTTP server ที่จะใช้ร่วมกับ Socket.io
const { Server } = require('socket.io'); // นำเข้า Server จาก socket.io เพื่อสร้าง WebSocket server สำหรับการสื่อสารแบบเรียลไทม์ระหว่างเซิร์ฟเวอร์และไคลเอนต์
const path = require('path'); // นำเข้า path module เพื่อจัดการกับเส้นทางของไฟล์และโฟลเดอร์ในระบบไฟล์
const { Client, validateSignature, messagingApi } = require('@line/bot-sdk'); // นำเข้า Client, validateSignature, และ messagingApi จาก @line/bot-sdk เพื่อใช้ในการเชื่อมต่อและส่งข้อความผ่าน LINE Messaging API
const vision = require('@google-cloud/vision'); // นำเข้า Google Cloud Vision API client สำหรับการประมวลผล OCR บนรูปภาพ
const speech = require('@google-cloud/speech'); // นำเข้า Google Cloud Speech-to-Text API client สำหรับการประมวลผลแปลงเสียงเป็นข้อความ
const multer = require('multer');


// ── VIGI Camera Config ──


// ==========================================
// Express & Server Setup
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ==========================================
// Database Setup
// ==========================================
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

const waitForDb = async (retries = 10, delay = 3000) => {
    for (let i = 1; i <= retries; i++) {
        try {
            const client = await pool.connect();
            console.log('✅ PostgreSQL connected');
            client.release();
            return true;
        } catch (err) {
            console.log(`⏳ DB ยังไม่พร้อม รอ... (${i}/${retries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    console.error('❌ เชื่อมต่อ DB ไม่ได้');
    process.exit(1);
};

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS houses (
                house_number VARCHAR(10) PRIMARY KEY,
                house_name VARCHAR(100)
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id VARCHAR(20) PRIMARY KEY,
                house_number VARCHAR(10),
                numeric_room_id INTEGER NOT NULL,
                camera_user_id VARCHAR(50),
                resident_user_id VARCHAR(50),
                sdk_app_id VARCHAR(20),
                resident_sig TEXT,
                camera_sig TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const newCols = ['camera_user_id VARCHAR(50)', 'resident_user_id VARCHAR(50)', 'sdk_app_id VARCHAR(20)', 'resident_sig TEXT', 'camera_sig TEXT'];
        for (const col of newCols) {
            await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ${col};`).catch(() => {});
        }
        await pool.query(`
            CREATE TABLE IF NOT EXISTS house_tokens (
                token VARCHAR(64) PRIMARY KEY,
                house_number VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`ALTER TABLE house_tokens ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(50);`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS visitor_logs (
                id SERIAL PRIMARY KEY,
                house_number VARCHAR(10),
                room_code VARCHAR(20),
                id_number VARCHAR(20),
                name_th TEXT,
                name_en TEXT,
                birth_date VARCHAR(30),
                exp_date VARCHAR(30),
                ocr_raw TEXT,
                photo_url TEXT,
                card_type VARCHAR(50),
                status VARCHAR(20) DEFAULT 'pending',
                completed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`ALTER TABLE visitor_logs ADD COLUMN IF NOT EXISTS card_type VARCHAR(50);`);
        await pool.query(`ALTER TABLE visitor_logs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;`);
        // กันบัตรใบเดียวกันมี pending ซ้อนกันมากกว่า 1 รายการ (ป้องกัน race condition)
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS visitor_logs_pending_id_number_idx
            ON visitor_logs (id_number)
            WHERE status = 'pending' AND id_number IS NOT NULL;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS house_tokens_house_number_idx
            ON house_tokens (house_number);
        `);
        await pool.query(`
            INSERT INTO houses (house_number, house_name) VALUES
            ('101', 'บ้านเลขที่ 101'),
            ('102', 'บ้านเลขที่ 102'),
            ('103', 'บ้านเลขที่ 103')
            ON CONFLICT DO NOTHING;
        `);
        console.log('✅ Tables ready');
    } catch (err) {
        console.error('initDb error:', err);
    }
};

waitForDb().then(() => initDb());

// ==========================================
// TRTC Utilities
// ==========================================
const USERSIG_VALIDITY = 86400;
const generateUserSig = (userId) => {
    const api = new TLSSigAPIv2.Api(parseInt(process.env.TRTC_SDKAPPID), process.env.TRTC_SECRETKEY);
    return api.genUserSig(userId, USERSIG_VALIDITY);
};
const generateNumericRoomId = () => Math.floor(100000 + Math.random() * 900000);
const generateRoomCode = () => {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};
const generateToken = () => require('crypto').randomBytes(24).toString('hex');

// ==========================================
// Google Cloud Clients Setup
// ==========================================
const visionClient = new vision.ImageAnnotatorClient({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    projectId: process.env.GOOGLE_PROJECT_ID,
});

const speechClient = new speech.SpeechClient({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    projectId: process.env.GOOGLE_PROJECT_ID,
});

// ==========================================
// OCR Parsing Utilities
// ==========================================
function parseHouseNumber(text) {
    if (!text) return null;
    const cleaned = text.trim().toLowerCase();
    const digits = cleaned.match(/\d{2,4}/);
    if (digits) return digits[0];

    const wordMap = {
        'ศูนย์': '0', 'เลขศูนย์': '0', 'หนึ่ง': '1', 'เอ็ด': '1', 'สอง': '2', 'ยี่': '2', 'สาม': '3',
        'สี่': '4', 'ห้า': '5', 'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9'
    };
    let transformed = cleaned;
    Object.keys(wordMap).forEach(word => {
        transformed = transformed.split(word).join(wordMap[word]);
    });
    const numeric = transformed.match(/\d{2,4}/);
    return numeric ? numeric[0] : null;
}

function parseThaiIdCard(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const full = text.replace(/\n/g, ' ');
    
    // ── เลขบัตร 13 หลัก ──
    let idNumber = null;
    const idPatterns = [
        /\b(\d[\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d)\b/,
        /\b(\d{13})\b/,
        /(\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d)/
    ];
    for (const p of idPatterns) {
        const m = full.match(p);
        if (m) { idNumber = m[1].replace(/[\s-]/g, ''); break; }
    }
   
    // ── ชื่อภาษาไทย ──
    let nameTh = null;
    const prefixPattern = /((?:นาย|นางสาว|นาง|ด\.?ญ\.?|ด\.?ช\.?)\s*[\u0E00-\u0E7F][\u0E00-\u0E7F\s]{2,30})/;
    const pm = full.match(prefixPattern);
    if (pm) nameTh = pm[1].trim().replace(/\s+/g, ' ').substring(0, 40);

    if (!nameTh) {
        for (const line of lines) {
            if (/ชื่อ/.test(line)) {
                const cleaned = line.replace(/[^\u0E00-\u0E7F\s]/g, ' ').trim();
                const clusters = cleaned.match(/[\u0E00-\u0E7F]{2,}(?:\s+[\u0E00-\u0E7F]{2,})*/g) || [];
                const skip = /^(ชื่อ|บัตร|ประจำ|ตัว|ประชาชน|และ|เลข)$/;
                const valid = clusters.filter(c => !skip.test(c.trim()) && c.trim().length > 2);
                if (valid.length > 0) {
                    nameTh = valid.sort((a, b) => b.length - a.length)[0].trim();
                }
                break;
            }
        }
    }

    if (!nameTh) {
        for (const line of lines) {
            if (/^(นาย|นางสาว|นาง|ด\.ญ\.|ด\.ช\.)/.test(line) && line.length > 4) {
                nameTh = line.replace(/\s+/g, ' ').substring(0, 40);
                break;
            }
        }
    }

    // ── ชื่อภาษาอังกฤษ ──
    let firstName = null;
    let lastName = null;

    for (let i = 0; i < lines.length; i++) {
        const mFirstInLine = lines[i].match(/((?:Mr\.?|Mrs\.?|Miss|Ms\.?)\s+[A-Za-z][a-zA-Z\s]*)/i);
        if (mFirstInLine) {
            firstName = mFirstInLine[1].trim();
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const mLast = lines[j].match(/^(?:Last\s*name|Lastname)[:\s]+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
                if (mLast) { lastName = mLast[1].trim(); break; }
                const mPlain = lines[j].match(/^([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})*)$/);
                const skip = /^(Last|Name|Date|Birth|Religion|Address|Thai|National|Meme|Ref)/i;
                if (mPlain && !skip.test(lines[j])) { lastName = mPlain[1].trim(); break; }
            }
            break;
        }
    }

    if (!lastName) {
        for (let i = 0; i < lines.length; i++) {
            const label = lines[i].trim();
            if (/Surname|Family\s*name|Last\s*name|Lastname|นามสกุล|Sum\w*/i.test(label)) {
                const sameLineMatch = label.match(/(?:Surname|Family\s*name|Last\s*name|Lastname|Sum\w*)[:\/]\s*([A-Za-z][A-Za-z\s<-]{2,})/i);
                if (sameLineMatch) {
                    lastName = sameLineMatch[1].replace(/<+/g, ' ').trim();
                    break;
                }
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                    const candidate = lines[j].trim();
                    const upperMatch = candidate.match(/([A-Z][A-Z-]+(?:\s+[A-Z][A-Z-]+)*)/);
                    if (upperMatch) {
                        lastName = upperMatch[1].replace(/<+/g, ' ').trim();
                        break;
                    }
                }
                if (lastName) break;
            }
        }
    }

    let nameEn = null;
    if (firstName && lastName) {
        nameEn = `${firstName} ${lastName}`;
    } else if (firstName) {
        nameEn = firstName;
    }

    // ── ประเภทบัตร ──
    let cardType = 'ไม่ระบุประเภท';
    if (/passport|หนังสือเดินทาง/i.test(full)) {
        cardType = 'หนังสือเดินทาง';
    } else if (/ใบอนุญาตขับร|driving licen/i.test(full)) {
        cardType = 'ใบอนุญาตขับขี่';
    } else if (/ประจำตัวประชาชน|national id|thai national/i.test(full)) {
        cardType = 'บัตรประจำตัวประชาชน';
    } else if (idNumber && idNumber.length === 13) {
        cardType = 'บัตรประจำตัวประชาชน';
    }

    // ── วันเกิด ──
    let birthDate = null;
    const bdPatterns = [
        /เกิดวันที่[^\d]*(\d{1,2}\s+\S+\.?\s+\d{4})/,
        /Date of Birth[^\d]*(\d{1,2}\s+\w+\.?\s+\d{4})/i,
        /(\d{1,2}\s+(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{4})/,
        /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4})/i,
    ];
    for (const p of bdPatterns) {
        const m = full.match(p);
        if (m) { birthDate = m[1].trim(); break; }
    }

    // ── วันหมดอายุ ──
    let expDate = null;
    const expPatterns = [
        /(?:หมดอายุ|วันหมดอายุ)[^\d]*(\d{1,2}\s+\S+\.?\s+\d{4})/,
        /(?:Expiry|Expired)[^\d]*(\d{1,2}\s+\w+\.?\s+\d{4})/i,
    ];
    for (const p of expPatterns) {
        const m = full.match(p);
        if (m) { expDate = m[1].trim(); break; }
    }

    return { idNumber, nameTh, nameEn, lastName, birthDate, expDate, cardType, rawText: text };
}

// ==========================================
// LINE Setup & Message Handler
// ==========================================
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });

const sendLineMessage = async (lineUserId, houseNumber, residentUrl, visitorInfo = null) => {
    if (!lineUserId) return false;

    const bodyContents = [
        { type: 'text', text: '🔔 มีผู้ต้องการติดต่อ', weight: 'bold', size: 'md', color: '#1a1a1a' },
        { type: 'text', text: `บ้านเลขที่ ${houseNumber}`, size: 'sm', color: '#555555', margin: 'xs' }
    ];

    if (visitorInfo?.nameTh) {
        bodyContents.push({ type: 'separator', margin: 'md' });
        bodyContents.push({ type: 'text', text: '🪪 ข้อมูลผู้มาติดต่อ', size: 'xs', color: '#888888', margin: 'md' });
        bodyContents.push({ type: 'text', text: visitorInfo.nameTh, size: 'sm', weight: 'bold', color: '#1a1a1a', margin: 'xs' });
        if (visitorInfo.idNumber) bodyContents.push({ type: 'text', text: `บัตรเลข ${visitorInfo.idNumber}`, size: 'xs', color: '#888888', margin: 'xs' });
    }

    try {
        await lineClient.pushMessage({
            to: lineUserId,
            messages: [{
                type: 'flex',
                altText: `🔔 มีผู้ต้องการติดต่อ บ้าน ${houseNumber}${visitorInfo?.nameTh ? ' — ' + visitorInfo.nameTh : ''}`,
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: bodyContents },
                    footer: {
                        type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'md',
                        contents: [{
                            type: 'button',
                            action: { type: 'uri', label: '📞 กดรับสาย', uri: residentUrl },
                            style: 'primary', color: '#00B900', height: 'sm'
                        }]
                    }
                }
            }]
        });
        console.log(`💬 LINE message sent → บ้าน ${houseNumber}`);
        return true;
    } catch (err) {
        console.error(`❌ LINE send failed:`, err.message);
        return false;
    }
};

// ==========================================
// REST API — House Management
// ==========================================
app.get('/api/houses', async (req, res) => {
    try {
        const result = await pool.query('SELECT house_number, house_name FROM houses ORDER BY house_number');
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/admin/houses', async (req, res) => {
    const { houseNumber, houseName } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    const name = houseName || `บ้านเลขที่ ${houseNumber}`;
    try {
        await pool.query('INSERT INTO houses (house_number, house_name) VALUES ($1, $2)', [houseNumber, name]);
        console.log(`🏠 เพิ่มบ้าน ${houseNumber}`);
        res.json({ status: 'success', data: { houseNumber, houseName: name } });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ status: 'error', message: `บ้าน ${houseNumber} มีอยู่แล้ว` });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.delete('/api/admin/houses/:id', async (req, res) => {
    const houseNumber = req.params.id;
    try {
        await pool.query('DELETE FROM house_tokens WHERE house_number = $1', [houseNumber]);
        await pool.query('DELETE FROM rooms WHERE house_number = $1', [houseNumber]);
        const result = await pool.query('DELETE FROM houses WHERE house_number = $1', [houseNumber]);
        if (result.rowCount === 0) return res.status(404).json({ status: 'error', message: 'ไม่พบบ้านนี้' });
        console.log(`ลบบ้าน ${houseNumber}`);
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// REST API — Token Management
// ==========================================
app.get('/api/admin/tokens', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ht.token, ht.house_number, h.house_name, ht.created_at
             FROM house_tokens ht
             JOIN houses h ON h.house_number = ht.house_number
             ORDER BY ht.house_number`
        );
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/admin/tokens/generate', async (req, res) => {
    const { houseNumber } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    try {
        await pool.query('DELETE FROM house_tokens WHERE house_number = $1', [houseNumber]);
        const token = generateToken();
        await pool.query('INSERT INTO house_tokens (token, house_number) VALUES ($1, $2)', [token, houseNumber]);
        const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
        res.json({
            status: 'success',
            data: { houseNumber, token, url: `${baseUrl}/resident.html?house=${houseNumber}&token=${token}` }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/verify-token', async (req, res) => {
    const { house, token } = req.query;
    if (!house || !token) return res.status(400).json({ status: 'error', message: 'missing params' });
    try {
        const result = await pool.query(
            'SELECT house_number FROM house_tokens WHERE token = $1 AND house_number = $2',
            [token, house]
        );
        if (result.rows.length === 0) return res.status(403).json({ status: 'error', message: 'token ไม่ถูกต้อง' });
        const houseResult = await pool.query('SELECT house_name FROM houses WHERE house_number = $1', [house]);
        res.json({
            status: 'success',
            data: { houseNumber: house, houseName: houseResult.rows[0]?.house_name || `บ้านเลขที่ ${house}` }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// REST API — TRTC & Status
// ==========================================
app.post('/api/get-credentials', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ status: 'error', message: 'userId required' });
    try {
        res.json({ status: 'success', data: { userId, sdkAppId: process.env.TRTC_SDKAPPID, userSig: generateUserSig(userId) } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as t');
        res.json({ status: 'success', db_time: result.rows[0].t });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/pending-call', async (req, res) => {
    const { house, token, room } = req.query;
    if (!house || !token || !room) return res.status(400).json({ status: 'error', message: 'missing params' });
    try {
        const tokenResult = await pool.query(
            'SELECT house_number FROM house_tokens WHERE token = $1 AND house_number = $2',
            [token, house]
        );
        if (tokenResult.rows.length === 0) return res.status(403).json({ status: 'error', message: 'token ไม่ถูกต้อง' });

        const roomResult = await pool.query(
            `SELECT id, house_number, numeric_room_id, resident_user_id, sdk_app_id, resident_sig
             FROM rooms WHERE id = $1 AND house_number = $2`,
            [room, house]
        );
        if (roomResult.rows.length === 0) return res.status(404).json({ status: 'notfound', message: 'ไม่พบสายที่รอรับ' });

        const r = roomResult.rows[0];
        const visitorResult = await pool.query(
            'SELECT id_number, name_th, name_en, birth_date, card_type FROM visitor_logs WHERE room_code = $1 ORDER BY created_at DESC LIMIT 1',
            [room]
        );
        const vRow = visitorResult.rows[0];
        const visitorInfo = vRow ? {
            idNumber: vRow.id_number || null,
            nameTh: vRow.name_th || null,
            nameEn: vRow.name_en || null,
            birthDate: vRow.birth_date || null,
            cardType: vRow.card_type || null,
        } : null;

        res.json({
            status: 'success',
            data: {
                roomCode: r.id,
                houseNumber: r.house_number,
                roomId: r.numeric_room_id,
                userId: r.resident_user_id,
                sdkAppId: r.sdk_app_id,
                userSig: r.resident_sig,
                visitorInfo
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// REST API — OCR & Speech-to-Text
// ==========================================
app.post('/api/ocr', upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'ไม่พบรูปภาพ' });
    try {
        const [result] = await visionClient.documentTextDetection({
            image: { content: req.file.buffer },
            imageContext: { languageHints: ['th', 'en'] }
        });
        const rawText = result.fullTextAnnotation?.text || '';
        if (!rawText.trim()) return res.json({ status: 'success', data: { idNumber: null, nameTh: null, nameEn: null, rawText: '' } });
        const parsed = parseThaiIdCard(rawText);
        console.log('\n🔍 OCR result:', JSON.stringify(parsed));
        res.json({ status: 'success', data: parsed });
    } catch (err) {
        console.error('OCR error:', err.message);
        res.status(500).json({ status: 'error', message: 'OCR ล้มเหลว: ' + err.message });
    }
});

app.post('/api/speech-to-text', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'ไม่พบไฟล์เสียง' });
    try {
        const audioBytes = req.file.buffer.toString('base64');
        const [response] = await speechClient.recognize({
            config: {
                encoding: 'WEBM_OPUS',
                sampleRateHertz: 48000,
                languageCode: 'th-TH',
                enableAutomaticPunctuation: false,
            },
            audio: { content: audioBytes }
        });
        const transcript = response.results.map(r => r.alternatives[0]?.transcript || '').join(' ').trim();
        const houseNumber = parseHouseNumber(transcript);
        res.json({ status: 'success', data: { transcript, houseNumber } });
    } catch (err) {
        console.error('Speech-to-text error:', err.message);
        res.status(500).json({ status: 'error', message: 'Speech-to-text ล้มเหลว: ' + err.message });
    }
});

// ==========================================
// REST API — Visitor Logs
// ==========================================
app.post('/api/visitor-log', async (req, res) => {
    const { houseNumber, roomCode, idNumber, nameTh, nameEn, birthDate, expDate, ocrRaw } = req.body;
    try {
        const r = await pool.query(
            `INSERT INTO visitor_logs (house_number, room_code, id_number, name_th, name_en, birth_date, exp_date, ocr_raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [houseNumber, roomCode, idNumber, nameTh, nameEn, birthDate, expDate, ocrRaw]
        );
        res.json({ status: 'success', data: { logId: r.rows[0].id } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/visitor-logs', async (req, res) => {
    const { house, limit = 50 } = req.query;
    try {
        const q = house
            ? `SELECT * FROM visitor_logs WHERE house_number = $1 ORDER BY created_at DESC LIMIT $2`
            : `SELECT * FROM visitor_logs ORDER BY created_at DESC LIMIT $1`;
        const params = house ? [house, limit] : [limit];
        const result = await pool.query(q, params);
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.post('/api/exit-scan', async (req, res) => {
    const { idNumber } = req.body;
    if (!idNumber) return res.status(400).json({ status: 'error', message: 'idNumber required' });
    try {
        const result = await pool.query(
            `SELECT id, house_number FROM visitor_logs
             WHERE id_number = $1 AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [idNumber]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'คุณสแกนออกเรียบร้อยแล้ว' });
        }
        const log = result.rows[0];
        await pool.query(
            `UPDATE visitor_logs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [log.id]
        );
        res.json({ status: 'success', data: { logId: log.id, houseNumber: log.house_number } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// REST API — LINE Webhook & Management
// ==========================================
const lineWebhookMiddleware = (req, res, next) => {
    const signature = req.headers['x-line-signature'];
    if (!validateSignature(JSON.stringify(req.body), lineConfig.channelSecret, signature)) {
        return res.status(403).send('Invalid signature');
    }
    next();
};

app.post('/webhook/line', lineWebhookMiddleware, async (req, res) => {
    res.sendStatus(200);

    const events = req.body.events || [];
    for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const lineUserId = event.source.userId;
        const text = event.message.text.trim();

        const houseMatch = text.match(/^(\d{2,4})$/);
        if (!houseMatch) {
            await lineClient.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: '📌 กรุณาพิมพ์เลขที่บ้านของคุณ เช่น 101' }]
            });
            continue;
        }

        const houseNumber = houseMatch[1];

        const houseResult = await pool.query(
            'SELECT house_name FROM houses WHERE house_number = $1',
            [houseNumber]
        );
        if (houseResult.rows.length === 0) {
            await lineClient.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: `❌ ไม่พบบ้านเลขที่ ${houseNumber} ในระบบ` }]
            });
            continue;
        }

        await pool.query(
            `INSERT INTO house_tokens (token, house_number, line_user_id)
             VALUES (gen_random_uuid()::text, $2, $1)
             ON CONFLICT (house_number)
             DO UPDATE SET line_user_id = $1`,
            [lineUserId, houseNumber]
        );

        const houseName = houseResult.rows[0].house_name;
        console.log(`💬 LINE registered: ${lineUserId} → บ้าน ${houseNumber}`);

        await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `✅ ลงทะเบียน ${houseName} สำเร็จแล้ว!\n\nเมื่อมีไรเดอร์กดกริ่ง คุณจะได้รับข้อความพร้อมลิ้งรับสายในแชทนี้ครับ 🔔` }]
        });
    }
});

app.post('/api/admin/line/reset', async (req, res) => {
    const { houseNumber } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    try {
        await pool.query('UPDATE house_tokens SET line_user_id = NULL WHERE house_number = $1', [houseNumber]);
        console.log(`🔄 Reset LINE user บ้าน ${houseNumber}`);
        res.json({ status: 'success', message: `ล้าง LINE บ้าน ${houseNumber} แล้ว` });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// สร้าง Endpoint ที่รองรับ HTTP GET Method สำหรับให้แอดมินใช้ตรวจสอบสถานะการเชื่อมต่อ LINE ของบ้านแต่ละหลัง โดยจะดึงข้อมูลเลขที่บ้าน ชื่อบ้าน และสถานะการเชื่อมต่อ LINE (มี LINE User ID หรือไม่) จากฐานข้อมูล และส่งกลับไปในรูปแบบ JSON ซึ่งจะช่วยให้แอดมินสามารถดูได้ว่าบ้านหลังไหนมีการเชื่อมต่อกับ LINE แล้วบ้าง และบ้านหลังไหนยังไม่มีการเชื่อมต่อ เพื่อที่จะได้ดำเนินการแก้ไขหรือแจ้งเตือนเจ้าของบ้านได้อย่างเหมาะสม
app.get('/api/admin/line/status', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT h.house_number, h.house_name,
                    ht.line_user_id IS NOT NULL as has_line
             FROM houses h
             LEFT JOIN house_tokens ht ON ht.house_number = h.house_number
             ORDER BY h.house_number`
        );
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// Socket.io — Room Management
// ==========================================
const residentSockets = {};
const cameraSockets = {};
const autoCloseTimers = {};
const AUTO_CLOSE_MS = 2 * 60 * 1000;
const PUSH_WAIT_MS = 90 * 1000;

function startAutoCloseTimer(roomCode) {
    if (autoCloseTimers[roomCode]) clearTimeout(autoCloseTimers[roomCode]);
    autoCloseTimers[roomCode] = setTimeout(async () => {
        console.log(`⏱️ Auto-close room ${roomCode}`);
        io.emit('call_ended', { roomCode, reason: 'timeout' });
        await cleanupRoom(roomCode);
    }, AUTO_CLOSE_MS);
}

function startPushWaitTimer(roomCode, cameraSocketId) {
    if (autoCloseTimers[roomCode]) clearTimeout(autoCloseTimers[roomCode]);
    autoCloseTimers[roomCode] = setTimeout(async () => {
        console.log(`⏱️ Push wait timeout room ${roomCode} — ลูกบ้านไม่รับ`);
        if (cameraSocketId) {
            io.to(cameraSocketId).emit('call_ended', { roomCode, reason: 'timeout' });
        }
        await cleanupRoom(roomCode);
    }, PUSH_WAIT_MS);
}

async function cleanupRoom(roomCode) {
    if (autoCloseTimers[roomCode]) { clearTimeout(autoCloseTimers[roomCode]); delete autoCloseTimers[roomCode]; }
    try { await pool.query('DELETE FROM rooms WHERE id = $1', [roomCode]); } catch (e) {}
}

// ==========================================
// Socket.io — Event Handlers
// ==========================================
io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    socket.on('register_camera', () => {
        cameraSockets[socket.id] = { role: 'camera' };
        console.log(`📷 Camera registered: ${socket.id}`);
    });

    socket.on('register_resident', ({ houseNumber }) => {
        residentSockets[houseNumber] = socket.id;
        console.log(`🏠 Resident ${houseNumber} registered: ${socket.id}`);
    });

    socket.on('ring', async ({ houseNumber, visitorInfo }) => {
        const numericRoomId = generateNumericRoomId();
        const roomCode = generateRoomCode();
        const cameraUserId = `camera_${houseNumber}`;
        const residentUserId = `resident_${houseNumber}`;
        const sdkAppId = process.env.TRTC_SDKAPPID;
        const cameraSig = generateUserSig(cameraUserId);
        const residentSig = generateUserSig(residentUserId);
        const roomPayload = { houseNumber, roomCode, roomId: numericRoomId, sdkAppId };

        let houseUrlToken, lineUserId;
        try {
            const [, tokenResult] = await Promise.all([
                pool.query(
                    `INSERT INTO rooms (id, house_number, numeric_room_id, camera_user_id, resident_user_id, sdk_app_id, resident_sig, camera_sig)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [roomCode, houseNumber, numericRoomId, cameraUserId, residentUserId, sdkAppId, residentSig, cameraSig]
                ),
                pool.query('SELECT token, line_user_id FROM house_tokens WHERE house_number = $1', [houseNumber])
            ]);
            houseUrlToken = tokenResult.rows[0]?.token;
            lineUserId = tokenResult.rows[0]?.line_user_id;
        } catch (err) {
            socket.emit('ring_error', { message: 'สร้างห้องไม่สำเร็จ' });
            return;
        }

        if (!houseUrlToken) {
            await cleanupRoom(roomCode);
            socket.emit('ring_error', { message: `ไม่พบลูกบ้าน ${houseNumber} ในระบบ` });
            return;
        }

        const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
        const residentUrl = `${baseUrl}/resident.html?house=${houseNumber}&token=${houseUrlToken}&room=${roomCode}`;

        if (visitorInfo?.idNumber || visitorInfo?.nameTh || visitorInfo?.nameEn) {
            pool.query(
                `INSERT INTO visitor_logs (house_number, room_code, id_number, name_th, name_en, birth_date, card_type, ocr_raw)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id_number) WHERE status = 'pending' AND id_number IS NOT NULL
                 DO NOTHING`,
                [houseNumber, roomCode, visitorInfo.idNumber || null, visitorInfo.nameTh || null,
                 visitorInfo.nameEn || null, visitorInfo.birthDate || null, visitorInfo.cardType || null,
                 visitorInfo.rawText || null]
            ).then(r => {
                if (r.rowCount === 0 && visitorInfo.idNumber) {
                    console.warn(`⚠️ idNumber ${visitorInfo.idNumber} มี pending ค้างอยู่แล้ว — ข้าม insert ซ้ำ`);
                }
            }).catch(e => console.warn('visitor_log insert failed:', e.message));
        }

        if (lineUserId) {
            sendLineMessage(lineUserId, houseNumber, residentUrl, visitorInfo || null);
            console.log(`💬 LINE message fired → บ้าน ${houseNumber}`);
        }

        const residentSocketId = residentSockets[houseNumber];
        if (residentSocketId) {
            io.to(residentSocketId).emit('incoming_call', {
                ...roomPayload,
                userId: residentUserId,
                userSig: residentSig,
                visitorInfo: visitorInfo || null
            });
            console.log(`📞 Ring via socket → บ้าน ${houseNumber}`);
        }

        startPushWaitTimer(roomCode, socket.id);
        socket.emit('room_created', { ...roomPayload, userId: cameraUserId, userSig: cameraSig });
        if (!residentSockets[houseNumber]) {
            socket.emit('ring_offline', {
                message: `บ้าน ${houseNumber} ออฟไลน์ — ส่งแจ้งเตือนแล้ว กำลังรอลูกบ้านรับสาย...`
            });
        }
    });

    socket.on('accept_call', ({ roomCode, houseNumber, startAt }) => {
        console.log(`✅ House ${houseNumber} accepted call in room ${roomCode}`);
        const resolvedStartAt = startAt || Date.now();
        io.emit('call_accepted', { roomCode, houseNumber, startAt: resolvedStartAt });
        startAutoCloseTimer(roomCode);
    });

    socket.on('reject_call', ({ roomCode, houseNumber }) => {
        console.log(`❌ House ${houseNumber} rejected`);
        io.emit('call_ended', { roomCode, reason: 'rejected' });
        cleanupRoom(roomCode);
    });

    socket.on('end_call', ({ roomCode }) => {
        console.log(`📵 end_call room ${roomCode}`);
        io.emit('call_ended', { roomCode, reason: 'hangup' });
        cleanupRoom(roomCode);
    });

    socket.on('disconnect', () => {
        for (const [house, sid] of Object.entries(residentSockets)) {
            if (sid === socket.id) { delete residentSockets[house]; console.log(`🏠 Resident ${house} disconnected`); }
        }
        delete cameraSockets[socket.id];
        console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
});

// ==========================================
// Start Server
// ==========================================
const PORT = process.env.PORT || 3001;
// ==========================================
// VIGI Camera — Persistent ffmpeg MJPEG stream
// ==========================================
const { spawn } = require('child_process');

// base URL จาก env (ปัจจุบันชี้ stream2) — ใช้เป็นฐานอนุมาน sub/main
const VIGI_RTSP_BASE = process.env.VIGI_RTSP_URL || 'rtsp://admin:P@ssw0rd1@172.25.11.210:554/stream1';
// sub stream (ความละเอียดต่ำ) = live preview ดีเลย์ต่ำ → stream2
const VIGI_RTSP_SUB  = process.env.VIGI_RTSP_SUB_URL  || VIGI_RTSP_BASE.replace(/stream1(\b|$)/, 'stream2');
// main stream (4MP) = snapshot คมชัดสำหรับ OCR → stream1
const VIGI_RTSP_MAIN = process.env.VIGI_RTSP_MAIN_URL || VIGI_RTSP_BASE.replace(/stream2(\b|$)/, 'stream1');

let latestFrame      = null;
let vigiProcess      = null;
let vigiRestartTimer = null;
const SOI = Buffer.from([0xFF, 0xD8]);

function startVigiStream() {
    if (vigiProcess) return;

    const args = [
        '-rtsp_transport', 'tcp',
        '-flags', 'low_delay',
        '-fflags', 'nobuffer+discardcorrupt',
        '-analyzeduration', '0',
        '-probesize', '32',
        '-i', VIGI_RTSP_SUB,   // preview ใช้ sub-stream
        '-an',                 // ตัด audio ทิ้ง ลดงาน
        '-vf', 'fps=15',
        '-q:v', '8',
        '-s', '640x360',
        '-f', 'mjpeg',
        'pipe:1'
    ];

    console.log('📷 Starting VIGI ffmpeg stream...');
    vigiProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    let buf = Buffer.alloc(0);
    const EOI = Buffer.from([0xFF, 0xD9]);

    vigiProcess.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let start = 0;
        while (true) {
            const sIdx = buf.indexOf(SOI, start);
            if (sIdx === -1) break;
            const eIdx = buf.indexOf(EOI, sIdx + 2);
            if (eIdx === -1) break;
            latestFrame = buf.slice(sIdx, eIdx + 2);
            start = eIdx + 2;
        }
        buf = buf.slice(start);
        if (buf.length > 2 * 1024 * 1024) buf = Buffer.alloc(0);
    });

    vigiProcess.on('close', (code) => {
        console.warn(`⚠️  VIGI ffmpeg exited (${code}) — restart in 3s`);
        vigiProcess = null;
        vigiRestartTimer = setTimeout(startVigiStream, 3000);
    });

    vigiProcess.on('error', (err) => {
        console.error('VIGI ffmpeg error:', err.message);
        vigiProcess = null;
        vigiRestartTimer = setTimeout(startVigiStream, 3000);
    });
}

startVigiStream();

process.on('SIGTERM', () => { vigiProcess?.kill(); });
process.on('SIGINT',  () => { vigiProcess?.kill(); });

// API endpoint — snapshot คมชัดสำหรับ OCR
// ดึง 1 เฟรม full-res จาก MAIN stream สดๆ (ภาพคมกว่า preview มาก) ถ้าล้มเหลวค่อย fallback เป็น preview frame
let snapInFlight = false;
app.get('/api/vigi-snapshot', (req, res) => {
    if (snapInFlight) {
        // มีคนถ่ายอยู่ — ส่ง preview frame ไปก่อน กันชน ffmpeg ซ้อน
        if (latestFrame) {
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': latestFrame.length });
            return res.send(latestFrame);
        }
        return res.status(503).json({ status: 'error', message: 'กล้องกำลังประมวลผล กรุณารอสักครู่' });
    }

    snapInFlight = true;
    const args = [
        '-rtsp_transport', 'tcp',
        '-i', VIGI_RTSP_MAIN,   // ภาพคมจาก main stream
        '-frames:v', '1',
        '-q:v', '2',            // คุณภาพสูงสำหรับ OCR
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        'pipe:1'
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let finished = false;

    const timeout = setTimeout(() => { if (!finished) { try { p.kill('SIGKILL'); } catch (_) {} } }, 6000);

    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', () => {});
    p.on('close', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        snapInFlight = false;
        const img = Buffer.concat(chunks);
        if (img.length > 1000) {
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': img.length });
            return res.send(img);
        }
        // fallback: ใช้ preview frame ล่าสุด
        if (latestFrame) {
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': latestFrame.length });
            return res.send(latestFrame);
        }
        res.status(503).json({ status: 'error', message: 'กล้องยังไม่พร้อม กรุณารอสักครู่' });
    });
});

// MJPEG stream endpoint — browser แสดงผลผ่าน <img src> โดยตรง ไม่ต้องใช้ JS loop
// latency ต่ำกว่า fetch loop มาก เพราะไม่มี HTTP overhead ต่อ frame
app.get('/api/vigi-stream', (req, res) => {
    res.set({
        'Content-Type': 'multipart/x-mixed-replace; boundary=--mjpegframe',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // ปิด nginx buffering (ถ้ามี reverse proxy)
    });

    let alive    = true;
    let draining = false;   // true เมื่อ socket เต็ม รอ 'drain'
    let lastSent = null;    // กัน push เฟรมเดิมซ้ำ

    function pushFrame() {
        if (!alive || !latestFrame) return;
        if (latestFrame === lastSent) return; // ไม่มีเฟรมใหม่ → ข้าม
        if (draining) return;                 // client รับไม่ทัน → ทิ้งเฟรม ไม่กองค้าง (กันดีเลย์สะสม)
        const frame = latestFrame;            // snapshot ค่าปัจจุบัน กันเปลี่ยนระหว่างเขียน
        lastSent = frame;
        try {
            res.write('----mjpegframe\r\n');
            res.write('Content-Type: image/jpeg\r\n');
            res.write(`Content-Length: ${frame.length}\r\n\r\n`);
            const ok = res.write(frame);
            res.write('\r\n');
            if (!ok) {
                // buffer เต็ม — หยุดส่งจนกว่าจะระบายหมด แล้วค่อยส่งเฟรม "ล่าสุด" ต่อ
                draining = true;
                res.once('drain', () => { draining = false; });
            }
        } catch(e) {
            alive = false;
        }
    }

    // ส่ง frame แรกทันที ไม่ต้องรอ interval แรก
    pushFrame();
    const interval = setInterval(pushFrame, 66); // ~15fps ตรงกับ ffmpeg

    req.on('close', () => {
        alive = false;
        clearInterval(interval);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   📷 Camera  : http://localhost:${PORT}/camera.html`);
    console.log(`   🏠 Resident: http://localhost:${PORT}/resident.html`);
    console.log(`   🔑 Admin   : http://localhost:${PORT}/admin.html`);
});