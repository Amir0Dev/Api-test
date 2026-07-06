const express = require('express');
const app = express();
app.use(express.json());

const API_TOKEN = "MominSecretToken123!"; 

// ذاكرة لتخزين السيرفرات بناءً على كودها القصير الجديد
let liveServers = {};

// 1. استقبال تحديث اللاعبين من روبلوكس باستخدام الكود القصير
app.post('/api/servers/:serverCode/players', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || token !== API_TOKEN) {
        return res.status(401).json({ error: "Unauthorized: Invalid Token" });
    }

    const { serverCode } = req.params; // يستقبل الكود القصير مثل abq-1db
    const { playersList } = req.body;

    if (!playersList) {
        return res.status(400).json({ error: "Missing playersList" });
    }

    // حفظ البيانات بالكود القصير
    liveServers[serverCode] = {
        players: playersList,
        lastUpdated: new Date()
    };

    console.log(`[روبلوكس] تم تحديث السيرفر [${serverCode}] - اللاعبين:`, playersList);
    return res.json({ success: true, message: "Server updated" });
});

// 2. جلب اللاعبين لأي سيرفر عن طريق كوده القصير
app.get('/api/servers/:serverCode/players', (req, res) => {
    const { serverCode } = req.params;

    if (!liveServers[serverCode]) {
        return res.status(404).json({ error: "هذا السيرفر غير موجود أو تم إغلاقه" });
    }

    return res.json({
        serverCode: serverCode,
        totalPlayers: liveServers[serverCode].players.length,
        players: liveServers[serverCode].players
    });
});

// 3. حذف السيرفر عند الإغلاق
app.delete('/api/servers/:serverCode', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token === API_TOKEN) {
        const { serverCode } = req.params;
        delete liveServers[serverCode];
        console.log(`[روبلوكس] تم إغلاق وحذف السيرفر: ${serverCode}`);
        return res.json({ success: true });
    }
    return res.status(401).json({ error: "Unauthorized" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`السيرفر يعمل الآن على المنفذ ${PORT}`));