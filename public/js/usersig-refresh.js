// ==========================================
// Auto UserSig Refresh (ทุก 30 วินาที)
// ==========================================

let userSigRefreshInterval = null;

function startUserSigRefreshMonitor() {
    // หยุด interval เก่าก่อน (ถ้ามี)
    if (userSigRefreshInterval) {
        clearInterval(userSigRefreshInterval);
    }

    // ตรวจสอบและ refresh UserSig ทุก 30 วินาที
    userSigRefreshInterval = setInterval(async () => {
        const userSession = localStorage.getItem('userSession');
        if (!userSession) return;

        const session = JSON.parse(userSession);

        // ถ้าเข้าห้องแล้ว ถึงสำคัญตรวจสอบและ refresh
        if (!session.roomId) return;

        // ตรวจสอบว่า UserSig เหลือน้อยกว่า 1 นาที
        const now = Date.now();
        const userSigExpire = session.userSigExpireTime || 0;
        const timeUntilExpire = userSigExpire - now;

        if (timeUntilExpire < 60000) {
            console.log('🔄 UserSig กำลังหมดอายุ กำลัง refresh...');
            await refreshUserSig(session.userId);
        }
    }, 30000); // ตรวจสอบทุก 30 วินาที
}

async function refreshUserSig(userId) {
    try {
        const response = await fetch('/api/refresh-usersig', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        const result = await response.json();

        if (result.status === 'success') {
            const userSession = JSON.parse(localStorage.getItem('userSession'));

            // อัปเดต UserSig ใน session
            userSession.userSig = result.data.userSig;
            userSession.userSigExpireTime = Date.now() + result.data.expiresIn * 1000;

            localStorage.setItem('userSession', JSON.stringify(userSession));
            console.log('✅ UserSig refresh สำเร็จ! หมดอายุใน ' + result.data.expiresIn + ' วินาที');
        } else {
            console.error('❌ Refresh UserSig ล้มเหลว:', result.message);
        }
    } catch (error) {
        console.error('❌ Refresh UserSig เกิดข้อผิดพลาด:', error);
    }
}

function stopUserSigRefreshMonitor() {
    if (userSigRefreshInterval) {
        clearInterval(userSigRefreshInterval);
        userSigRefreshInterval = null;
        console.log('⏹️ หยุดการตรวจสอบ UserSig');
    }
}

// เมื่อ login สำเร็จ ให้บันทึก expiration time
function saveUserSigExpireTime() {
    const userSession = localStorage.getItem('userSession');
    if (!userSession) return;

    const session = JSON.parse(userSession);
    // USERSIG_VALIDITY = 86400 วินาที (24 ชั่วโมง)
    session.userSigExpireTime = Date.now() + 86400000; // 24 ชม
    localStorage.setItem('userSession', JSON.stringify(session));
}
