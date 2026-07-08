const express = require('express');
const path = require('path');


require("dotenv").config({
    path: path.join(__dirname, "../.env"),
    quiet: true
});

const app = express();

app.use(express.json());
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath));

const API_TOKEN = process.env.ApiToken
const CLIENT_ID = process.env.ClientId
const CLIENT_SECRET = process.env.ClientSecret
const REDIRECT_URI = process.env.RedirectURI

const ALLOWED_ADMINS = [
    2748615471,
    1,
];

let liveServers = {};      
let commandsQueue = {};    
let oauthStates = {};      
let activeAdmins = {};     
let rateLimits = {};
let scheduledShutdowns = {};

function smartRateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    
    if (!rateLimits[ip]) {
        rateLimits[ip] = [];
    }
    
    rateLimits[ip] = rateLimits[ip].filter(timestamp => now - timestamp < 10000);
    
    if (rateLimits[ip].length > 45) {
        return res.status(429).json({ error: "تم تجاوز حد الطلبات المسموح، يرجى الانتظار قليلا" });
    }
    
    rateLimits[ip].push(now);
    next();
}

function verifyAdminAccess(req, res, next) {
    const adminId = parseInt(req.body.senderId || req.body.userId || req.query.senderId || req.query.userId);
    
    if (!adminId || !ALLOWED_ADMINS.includes(adminId)) {
        return res.status(403).json({ error: "وصول غير مصرح به، ليس لديك صلاحية للقيام بهذا الإجراء" });
    }
    
    next();
}

app.use('/api/admin', smartRateLimiter);
app.use('/api/servers/:serverCode/commands', smartRateLimiter);

app.get('/oauth/login', (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).send("Missing state parameter");

    oauthStates[state] = { status: "pending", adminData: null };

    const robloxAuthUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile&response_type=code&state=${state}`;
    res.redirect(robloxAuthUrl);
});

app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates[state]) {
        return res.status(400).send("طلب غير صالح أو انتهت صلاحية الجلسة");
    }

    try {
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

        const userResponse = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
            headers: { "Authorization": `Bearer ${tokenData.access_token}` }
        });

        const userData = await userResponse.json();
        const robloxUserId = parseInt(userData.sub);
        const robloxUsername = userData.preferred_username || userData.name;

        if (!ALLOWED_ADMINS.includes(robloxUserId)) {
            oauthStates[state] = { status: "unauthorized", adminData: null };
            return res.send(`
                <body style="background:#020617;color:#f1f5f9;font-family:sans-serif;text-align:center;padding-top:100px;direction:rtl;">
                    <h2 style="color:#ef4444;">غير مصرح لك</h2>
                    <p>الحساب (${robloxUsername}) غير مدرج في قائمة الإدارة المركزية</p>
                </body>
            `);
        }

        oauthStates[state] = {
            status: "success",
            adminData: { userId: robloxUserId, username: robloxUsername }
        };

        res.send(`
            <body style="background:#020617;color:#f1f5f9;font-family:sans-serif;text-align:center;padding-top:100px;direction:rtl;">
                <h2 style="color:#10b981;">تم تسجيل الدخول بنجاح</h2>
                <p>مرحباً بك، يمكنك إغلاق هذه النافذة والعودة للتطبيق الآن</p>
                <script>setTimeout(() => window.close(), 3000);</script>
            </body>
        `);

    } catch (error) {
        console.error("OAuth Error:", error);
        oauthStates[state] = { status: "failed", adminData: null };
        res.status(500).send("حدث خطأ أثناء معالجة تسجيل الدخول");
    }
});

app.get('/api/auth/status', (req, res) => {
    const { state } = req.query;
    if (!state || !oauthStates[state]) return res.json({ status: "unknown" });

    const session = oauthStates[state];
    if (session.status === "success") {
        const { userId, username } = session.adminData;
        if (!activeAdmins[userId]) {
            activeAdmins[userId] = { userId, username, status: "offline", serverCode: null, updatedAt: new Date().toISOString() };
        }
    }
    res.json(session);
});

app.post('/api/admin/duty', verifyAdminAccess, (req, res) => {
    const { userId, action, serverCode } = req.body;
    const admin = activeAdmins[userId];

    if (!admin) return res.status(404).json({ error: "الأدمن غير مسجل دخوله" });

    if (action === "start") {
        if (!serverCode) return res.status(400).json({ error: "يجب تحديد كود السيرفر أولاً" });
        
        const server = liveServers[serverCode];
        if (!server) return res.status(404).json({ error: "السيرفر المطلوب غير نشط حالياً" });

        admin.status = "on_duty";
        admin.serverCode = serverCode;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "on_duty" });
    }

    if (action === "break") {
        if (admin.status !== "on_duty") {
            return res.status(400).json({ error: "لا يمكنك أخذ استراحة دون بدء النوبة أولاً" });
        }
        admin.status = "break";
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "break" });
    }

    if (action === "stop") {
        admin.status = "stop";
        admin.serverCode = null;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "off_duty" });
    }

    res.status(400).json({ error: "إجراء غير معروف" });
});

app.get('/api/admin/staff', verifyAdminAccess, (req, res) => {
    res.json({ staff: Object.values(activeAdmins) });
});

app.post('/api/servers/:serverCode/heartbeat', (req, res) => {
    const { serverCode } = req.params;
    const { playersList } = req.body; 
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "غير مصرح" });
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
        lastUpdated: Date.now()
    };

    const pendingCommands = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = []; 

    res.json({ success: true, commands: pendingCommands });
});

app.post('/api/servers/:serverCode/commands', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { action, target, reason, duration, senderId } = req.body;

    const admin = activeAdmins[senderId];
    if (!admin) return res.status(403).json({ error: "الأدمن غير مسجل في النظام" });

    if (action === "shutdown") {
        if (admin.status !== "on_duty" || admin.serverCode !== serverCode) {
            return res.status(403).json({ error: "لا يمكن تنفيذ أمر الإغلاق إلا إذا كنت في النوبة داخل هذا السيرفر" });
        }
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({ action, target, reason, duration, senderId });
    
    res.json({ success: true });
});

app.post('/api/servers/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { timeString, senderId } = req.body;

    const admin = activeAdmins[senderId];
    if (!admin || admin.status !== "on_duty" || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: "يجب أن تكون في النوبة لجدولة إغلاق هذا السيرفر" });
    }

    const targetTime = new Date(timeString).getTime();
    if (isNaN(targetTime) || targetTime <= Date.now()) {
        return res.status(400).json({ error: "الوقت المحدد غير صالح أو في الماضي" });
    }

    scheduledShutdowns[serverCode] = {
        executeAt: targetTime,
        formattedTime: timeString,
        senderId: senderId
    };

    res.json({ success: true, message: `تم جدولة الإغلاق بنجاح في الوقت المحدد: ${timeString}` });
});

app.delete('/api/servers/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    
    if (!scheduledShutdowns[serverCode]) {
        return res.status(404).json({ error: "لا يوجد إغلاق مجدول لهذا السيرفر" });
    }

    delete scheduledShutdowns[serverCode];
    res.json({ success: true, message: "تم إلغاء الإغلاق المجدول بنجاح" });
});

app.get('/api/servers/:serverCode/players', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "السيرفر مغلق أو غير موجود" });
    
    const schedule = scheduledShutdowns[serverCode] || null;
    res.json({
        ...serverData,
        scheduledShutdown: schedule ? { time: schedule.formattedTime, timestamp: schedule.executeAt } : null
    });
});

app.get('/api/servers/:serverCode/players/:playerId', verifyAdminAccess, (req, res) => {
    const { serverCode, playerId } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "السيرفر غير موجود" });

    const player = serverData.players.find(p => String(p.userId) === String(playerId) || p.name === playerId);
    if (!player) return res.status(404).json({ error: "اللاعب غير موجود حالياً في السيرفر" });

    res.json(player);
});

app.delete('/api/servers/:serverCode', (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    delete scheduledShutdowns[serverCode];
    
    Object.values(activeAdmins).forEach(admin => {
        if(admin.serverCode === serverCode) {
            admin.status = "stop";
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
        }
    });

    res.json({ success: true });
});

setInterval(() => {
    const now = Date.now();
    Object.keys(liveServers).forEach(serverCode => {
        if (now - liveServers[serverCode].lastUpdated > 7000) {
            delete liveServers[serverCode];
            delete commandsQueue[serverCode];
            delete scheduledShutdowns[serverCode];

            Object.values(activeAdmins).forEach(admin => {
                if (admin.serverCode === serverCode) {
                    admin.status = "stop";
                    admin.serverCode = null;
                    admin.updatedAt = new Date().toISOString();
                }
            });
        } else {
            if (scheduledShutdowns[serverCode] && now >= scheduledShutdowns[serverCode].executeAt) {
                if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
                commandsQueue[serverCode].push({
                    action: "shutdown",
                    target: "all",
                    reason: "إغلاق مجدول مسبقاً",
                    duration: 0,
                    senderId: scheduledShutdowns[serverCode].senderId
                });
                delete scheduledShutdowns[serverCode];
            }
        }
    });
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(PORT));