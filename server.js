const express = require('express');

const app = express();
app.use(express.json());

// 🔴 إعدادات الحماية والـ OAuth2 الخاصة بك
const API_TOKEN = "MominSecretToken123!"; 
const CLIENT_ID = "8623887428915616165";
const CLIENT_SECRET = "RBX-lwLlBBgNf06EqDj4IEbb9QO9yusPshCjnRlUKHSoWE-8N-bveUWaB6BxDDy5zOHz";
const REDIRECT_URI = "https://api-test-production-c8fc.up.railway.app/oauth/callback";

// 👥 قائمة معرفات الأدمنية المصرح لهم بدخول اللوحة (عدلها بأرقام الآيديات الحقيقية)
const ALLOWED_ADMINS = [
    2748615471, // مثال لايدي أدمن
    1,        // مثال آخر
];

let liveServers = {};      // تخزين بيانات السيرفرات واللاعبين
let commandsQueue = {};    // تخزين الأوامر المنتظرة لكل سيرفر
let oauthStates = {};      // تتبع عمليات تسجيل الدخول المؤقتة { state: { status, adminData } }
let activeAdmins = {};     // إدارة جلسات الأدمنية الحاليين { userId: { name, status, serverCode } }

// ==========================================
// 🔐 مسارات الـ OAuth2 والتحقق من الهوية
// ==========================================

// 1. بدء عملية تسجيل الدخول
app.get('/oauth/login', (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).send("Missing state parameter");

    oauthStates[state] = { status: "pending", adminData: null };

    const robloxAuthUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile&response_type=code&state=${state}`;
    res.redirect(robloxAuthUrl);
});

// 2. استقبال الرد من روبلوكس ومعالجة التوكن
app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates[state]) {
        return res.status(400).send("🚨 طلب غير صالح أو انتهت صلاحية الجلسة.");
    }

    try {
        // تبادل الـ Code بالـ Access Token
        const tokenResponse = await fetch("https://apis.roblox.com/oauth/v1/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: "authorization_code",
                code: code,
                redirect_uri: REDIRECT_URI
            })
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) throw new Error("Failed to get access token");

        // جلب معلومات المستخدم الأساسية من روبلوكس
        const userResponse = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
            headers: { "Authorization": `Bearer ${tokenData.access_token}` }
        });

        const userData = await userResponse.json();
        const robloxUserId = parseInt(userData.sub);
        const robloxUsername = userData.preferred_username || userData.name;

        // التحقق من وجود المعرف في قائمة الإدارة المصرحة
        if (!ALLOWED_ADMINS.includes(robloxUserId)) {
            oauthStates[state] = { status: "unauthorized", adminData: null };
            return res.send(`
                <body style="background:#020617;color:#f1f5f9;font-family:sans-serif;text-align:center;padding-top:100px;direction:rtl;">
                    <h2 style="color:#ef4444;">🚫 غير مصرح لك!</h2>
                    <p>الحساب (${robloxUsername}) غير مدرج في قائمة الإدارة المركزية.</p>
                </body>
            `);
        }

        // تسجيل الدخول بنجاح وتوثيق الجلسة
        oauthStates[state] = {
            status: "success",
            adminData: { userId: robloxUserId, username: robloxUsername }
        };

        res.send(`
            <body style="background:#020617;color:#f1f5f9;font-family:sans-serif;text-align:center;padding-top:100px;direction:rtl;">
                <h2 style="color:#10b981;">✅ تم تسجيل الدخول بنجاح!</h2>
                <p>مرحباً بك يا ${robloxUsername}، يمكنك إغلاق هذه النافذة والعودة للتطبيق الآن.</p>
                <script>setTimeout(() => window.close(), 3000);</script>
            </body>
        `);

    } catch (error) {
        console.error("OAuth Error:", error);
        oauthStates[state] = { status: "failed", adminData: null };
        res.status(500).send("حدث خطأ أثناء معالجة تسجيل الدخول.");
    }
});

// 3. فحص حالة التحقق من جهة التطبيق (Polling)
app.get('/api/auth/status', (req, res) => {
    const { state } = req.query;
    if (!state || !oauthStates[state]) return res.json({ status: "unknown" });

    const session = oauthStates[state];
    if (session.status === "success") {
        // نقل الأدمن إلى قائمة الإدارة النشطة بوضعية "خارج النوبة" افتراضياً
        const { userId, username } = session.adminData;
        if (!activeAdmins[userId]) {
            activeAdmins[userId] = { userId, username, status: "off_duty", serverCode: null };
        }
    }
    res.json(session);
});

// ==========================================
// 👔 نظام إدارة النوبات (Duty System)
// ==========================================

app.post('/api/admin/duty', (req, res) => {
    const { userId, action, serverCode } = req.body;
    const admin = activeAdmins[userId];

    if (!admin) return res.status(404).json({ error: "الأدمن غير مسجل دخوله" });

    if (action === "start") {
        if (!serverCode) return res.status(400).json({ error: "يجب تحديد كود السيرفر أولاً" });
        
        const server = liveServers[serverCode];
        if (!server) return res.status(404).json({ error: "السيرفر المطلوب غير نشط حالياً" });

        // التحقق من أن الأدمن متواجد فعلياً داخل خريطة اللعبة/السيرفر
        const isIngame = server.players.some(p => Number(p.userId) === Number(userId));
        if (!isIngame) {
            return res.status(403).json({ error: "🚨 لا يمكنك بدء النوبة! يجب أن تكون متواجداً بشخصيتك داخل الماب أولاً." });
        }

        admin.status = "on_duty";
        admin.serverCode = serverCode;
        return res.json({ success: true, status: "on_duty" });
    }

    if (action === "break") {
        admin.status = "break";
        return res.json({ success: true, status: "break" });
    }

    if (action === "stop") {
        admin.status = "off_duty";
        admin.serverCode = null;
        return res.json({ success: true, status: "off_duty" });
    }

    res.status(400).json({ error: "إجراء غير معروف" });
});

// جلب قائمة الطاقم الإداري الحالي وحالتهم لسيرفر معين
app.get('/api/admin/staff', (req, res) => {
    res.json({ staff: Object.values(activeAdmins) });
});

// ==========================================
// 🛡️ مسارات التحكم والسيرفر العادية
// ==========================================

app.post('/api/servers/:serverCode/heartbeat', (req, res) => {
    const { serverCode } = req.params;
    const { playersList } = req.body; 
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "غير مصرح!" });
    }

    let teamsCounter = {};
    playersList.forEach(player => {
        teamsCounter[player.team] = (teamsCounter[player.team] || 0) + 1;
    });

    liveServers[serverCode] = {
        serverCode: serverCode,
        totalPlayers: playersList.length,
        teamsSummary: teamsCounter,
        players: playersList,
        lastUpdated: new Date()
    };

    const pendingCommands = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = []; 

    res.json({ success: true, commands: pendingCommands });
});

app.post('/api/servers/:serverCode/commands', (req, res) => {
    const { serverCode } = req.params;
    const { action, target, reason, duration, senderId } = req.body;

    // قيود حماية على السيرفر: التأكد أن مرسل الأمر أدمن وفي وضعية النوبة
    const admin = activeAdmins[senderId];
    if (!admin || admin.status !== "on_duty" || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: "غير مصرح لك بالإشراف! يجب بدء النوبة داخل هذا السيرفر أولاً." });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({ action, target, reason, duration });
    
    res.json({ success: true });
});

app.get('/api/servers/:serverCode/players', (req, res) => {
    const { serverCode } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "السيرفر مغلق أو غير موجود" });
    res.json(serverData);
});

app.delete('/api/servers/:serverCode', (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    
    // إخراج أي أدمن كان يراقب هذا السيرفر تلقائياً لوضعية خارج النوبة
    Object.values(activeAdmins).forEach(admin => {
        if(admin.serverCode === serverCode) {
            admin.status = "off_duty";
            admin.serverCode = null;
        }
    });

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`سيرفر الإدارة المركزي النشط يعمل على منفذ ${PORT}`));