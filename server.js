const express = require('express');
const app = express();


app.use(express.json());

const API_TOKEN = "MominSecretToken123!"; 
let liveServers = {}; // تخزين السيرفرات الحية

// مسار استقبال البيانات من روبلوكس
app.post('/api/servers/:serverCode/players', (req, res) => {
    const { serverCode } = req.params;
    const { playersList } = req.body; 
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "غير مصرح لك بالدخول!" });
    }

    // حساب عدد اللاعبين في كل فريق تلقائياً
    let teamsCounter = {};
    playersList.forEach(player => {
        // لو الفريق مش موجود في العداد، نبدأه بـ 0 ونزيده 1
        teamsCounter[player.team] = (teamsCounter[player.team] || 0) + 1;
    });

    // حفظ البيانات الجديدة بالسيرفر
    liveServers[serverCode] = {
        serverCode: serverCode,
        totalPlayers: playersList.length,
        teamsSummary: teamsCounter, // يظهر كم شرطي وكم مسعف أونلاين
        players: playersList, // يظهر لستة اللاعبين مع أتيامهم
        lastUpdated: new Date()
    };

    console.log(`[روبلوكس] تم تحديث السيرفر [${serverCode}] - الإجمالي: ${playersList.length}`);
    res.json({ success: true, message: "تم تحديث الأتيام بنجاح" });
});

// مسار جلب البيانات (للمتصفح وبوت الديسكورد)
app.get('/api/servers/:serverCode/players', (req, res) => {
    const { serverCode } = req.params;
    const serverData = liveServers[serverCode];

    if (!serverData) {
        return res.status(404).json({ error: "هذا السيرفر غير موجود حالياً أو مغلق" });
    }

    res.json(serverData);
});

// حذف السيرفر عند الإغلاق
app.delete('/api/servers/:serverCode', (req, res) => {
    const { serverCode } = req.params;
    if (liveServers[serverCode]) {
        delete liveServers[serverCode];
        console.log(`[روبلوكس] تم إغلاق السيرفر وحذفه: ${serverCode}`);
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل الآن وتحديث الأتيام جاهز!`));