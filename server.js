const express = require('express');

const app = express();

app.use(express.json());

const API_TOKEN = "MominSecretToken123!"; 
let liveServers = {};      // تخزين بيانات السيرفرات واللاعبين
let commandsQueue = {};    // تخزين الأوامر المنتظرة (freeze, kick, ban) لكل سيرفر

// 🌟 مسار النبضة (Heartbeat) - روبلوكس تحدث البيانات وتستلم الأوامر هنا كل ثانيتين
app.post('/api/servers/:serverCode/heartbeat', (req, res) => {
    const { serverCode } = req.params;
    const { playersList } = req.body; 
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "غير مصرح!" });
    }

    // حساب إحصائيات الأتيام
    let teamsCounter = {};
    playersList.forEach(player => {
        teamsCounter[player.team] = (teamsCounter[player.team] || 0) + 1;
    });

    // تحديث البيانات الحية
    liveServers[serverCode] = {
        serverCode: serverCode,
        totalPlayers: playersList.length,
        teamsSummary: teamsCounter,
        players: playersList,
        lastUpdated: new Date()
    };

    // جلب الأوامر المنتظرة لهذا السيرفر وإرسالها لروبلوكس، ثم تفريغ الطابور
    const pendingCommands = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = []; // مسح الأوامر بعد إرسالها

    res.json({ success: true, commands: pendingCommands });
});

// مسار إرسال أمر من لوحة التحكم (البرنامج) إلى اللعبة
app.post('/api/servers/:serverCode/commands', (req, res) => {
    const { serverCode } = req.params;
    const { action, target, reason, duration } = req.body;

    if (!commandsQueue[serverCode]) {
        commandsQueue[serverCode] = [];
    }

    // إضافة الأمر للطابور لكي تسحبه روبلوكس في النبضة القادمة
    commandsQueue[serverCode].push({ action, target, reason, duration });
    
    console.log(`[لوحة التحكم] أمر جديد لسيرفر [${serverCode}]: ${action} على اللاعب ${target}`);
    res.json({ success: true, message: `تم إرسال أمر ${action} بنجاح` });
});

// مسار جلب البيانات للبرنامج تلقائياً
app.get('/api/servers/:serverCode/players', (req, res) => {
    const { serverCode } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "السيرفر مغلق أو غير موجود" });
    res.json(serverData);
});

// حذف السيرفر عند الإغلاق
app.delete('/api/servers/:serverCode', (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`سيرفر الإدارة المتطور يعمل على منفذ ${PORT}`));