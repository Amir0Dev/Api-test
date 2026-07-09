const express = require('express');
const path = require('path');

require("dotenv").config({
    path: path.join(__dirname, "../.env"),
    quiet: true
});

const app = express();
// تم زيادة الحد الأقصى للـ JSON لاستيعاب بيانات الخريطة القادمة من روبلوكس
app.use(express.json({ limit: '50mb' }));
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath));

const API_TOKEN = process.env.ApiToken;
const CLIENT_ID = process.env.ClientId;
const CLIENT_SECRET = process.env.ClientSecret;
const REDIRECT_URI = process.env.RedirectURI;

const ALLOWED_ADMINS = [
    2748615471,
    9801416277,
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
        return res.status(429).json({ error: "Rate limit exceeded" });
    }
    
    rateLimits[ip].push(now);
    next();
}

function verifyAdminAccess(req, res, next) {
    const adminId = parseInt(req.body?.senderId || req.body?.userId || req.query?.senderId || req.query?.userId);
    if (!adminId || isNaN(adminId) || !ALLOWED_ADMINS.includes(adminId)) {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    
    next();
}

app.use('/api/admin', smartRateLimiter);
app.use('/api/servers/:serverCode/commands', smartRateLimiter);

app.get('/oauth/login', (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).send("Missing state");

    oauthStates[state] = { status: "pending", adminData: null, time: Date.now() };

    const robloxAuthUrl = `https://apis.roblox.com/oauth/v1/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile&response_type=code&state=${state}`;
    res.redirect(robloxAuthUrl);
});

app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates[state]) {
        return res.send(`<script>setTimeout(() => window.close(), 100);</script>`);
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
        if (!tokenData.access_token) throw new Error("Token failed");

        const userResponse = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
            headers: { "Authorization": `Bearer ${tokenData.access_token}` }
        });

        const userData = await userResponse.json();
        const robloxUserId = parseInt(userData.sub);
        const robloxUsername = userData.preferred_username || userData.name;

        oauthStates[state] = {
            status: "success",
            adminData: { userId: robloxUserId, username: robloxUsername }
        };

        res.send(`<script>setTimeout(() => window.close(), 100);</script>`);

    } catch (error) {
        oauthStates[state] = { status: "failed", adminData: null };
        res.send(`<script>setTimeout(() => window.close(), 100);</script>`);
    }
});

app.get('/api/auth/status', (req, res) => {
    const { state } = req.query;
    if (!state || !oauthStates[state]) return res.json({ status: "unknown" });
    res.json(oauthStates[state]);
});

app.post('/api/admin/disconnect', (req, res) => {
    const { userId } = req.body;
    if (userId && activeAdmins[userId]) {
        delete activeAdmins[userId];
    }
    res.json({ success: true });
});

app.post('/api/admin/duty', verifyAdminAccess, (req, res) => {
    const { userId, username, action, serverCode } = req.body;
    const adminId = parseInt(userId);

    if (!activeAdmins[adminId]) {
        activeAdmins[adminId] = {
            userId: adminId,
            username: username || "Admin",
            status: "Online",
            serverCode: null,
            updatedAt: new Date().toISOString(),
            lastSeen: Date.now()
        };
    }

    const admin = activeAdmins[adminId];
    admin.lastSeen = Date.now();

    if (action === "start") {
        if (!serverCode) return res.status(400).json({ error: "Server code required" });
        
        const server = liveServers[serverCode];
        if (!server) return res.status(404).json({ error: "Server offline" });

        admin.status = "on_duty";
        admin.serverCode = serverCode;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "on_duty" });
    }

    if (action === "break") {
        if (admin.status !== "on_duty") {
            return res.status(400).json({ error: "Must be on duty" });
        }
        admin.status = "break";
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "break" });
    }

    if (action === "stop") {
        admin.status = "Online";
        admin.serverCode = null;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: "Online" });
    }

    res.status(400).json({ error: "Unknown action" });
});

app.get('/api/admin/staff', verifyAdminAccess, (req, res) => {
    const currentUserId = parseInt(req.query.userId);
    const currentUsername = req.query.username;
    const now = Date.now();

    if (currentUserId && ALLOWED_ADMINS.includes(currentUserId)) {
        if (!activeAdmins[currentUserId]) {
            activeAdmins[currentUserId] = {
                userId: currentUserId,
                username: currentUsername || "Admin",
                status: "Online",
                serverCode: null,
                updatedAt: new Date().toISOString(),
                lastSeen: now
            };
        } else {
            activeAdmins[currentUserId].lastSeen = now;
            if (activeAdmins[currentUserId].status === "Offline") {
                activeAdmins[currentUserId].status = "Online";
            }
        }
    }

    Object.keys(activeAdmins).forEach(userId => {
        const idNum = parseInt(userId);
        if (!ALLOWED_ADMINS.includes(idNum) || !activeAdmins[userId].lastSeen || now - activeAdmins[userId].lastSeen > 25000) {
            delete activeAdmins[userId];
        }
    });

    let staffArr = Object.values(activeAdmins);
    staffArr.sort((a, b) => {
        const order = { "on_duty": 1, "break": 2, "Online": 3 };
        return (order[a.status] || 4) - (order[b.status] || 4);
    });
    res.json({ staff: staffArr });
});

// Endpoint لاستقبال بيانات الماب من سيرفر روبلوكس
app.post('/api/servers/:serverCode/map', (req, res) => {
    const { serverCode } = req.params;
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    if (!liveServers[serverCode]) {
        liveServers[serverCode] = { startTime: Date.now() };
    }
    
    liveServers[serverCode].mapData = req.body;
    res.json({ success: true });
});

// Endpoint للواجهة الأمامية لجلب بيانات الماب
app.get('/api/servers/:serverCode/map', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server || !server.mapData) return res.status(404).json({ error: "Map not ready" });
    res.json(server.mapData);
});

app.post('/api/servers/:serverCode/heartbeat', (req, res) => {
    const { serverCode } = req.params;
    const { playersList } = req.body; 
    const authHeader = req.headers['authorization'];

    if (!authHeader || authHeader !== `Bearer ${API_TOKEN}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    let teamsCounter = {};
    if (Array.isArray(playersList)) {
        playersList.forEach(player => {
            teamsCounter[player.team] = (teamsCounter[player.team] || 0) + 1;
        });
    }

    if (!liveServers[serverCode]) {
        liveServers[serverCode] = { startTime: Date.now() };
    }

    liveServers[serverCode] = {
        ...liveServers[serverCode],
        startTime: liveServers[serverCode].startTime,
        serverCode: serverCode,
        totalPlayers: Array.isArray(playersList) ? playersList.length : 0,
        teamsSummary: teamsCounter,
        players: playersList || [],
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
    if (!admin) return res.status(403).json({ error: "Admin not found" });

    if (action === "shutdown") {
        if (admin.status !== "on_duty" || admin.serverCode !== serverCode) {
            return res.status(403).json({ error: "Duty required for this action" });
        }
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({ action, target, reason, duration, senderId });
    
    res.json({ success: true });
});

app.post('/api/servers/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { targetTimestamp, senderId } = req.body;

    const admin = activeAdmins[senderId];
    if (!admin || admin.status !== "on_duty" || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: "Duty required for this action" });
    }

    if (!targetTimestamp || targetTimestamp <= Date.now()) {
        return res.status(400).json({ error: "Please select a valid future time" });
    }

    const d = new Date(targetTimestamp);
    const formattedTime = d.toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    scheduledShutdowns[serverCode] = {
        executeAt: targetTimestamp,
        formattedTime: formattedTime,
        senderId: senderId
    };

    res.json({ success: true, message: `Scheduled shutdown at: ${formattedTime}` });
});

app.delete('/api/servers/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    
    if (!scheduledShutdowns[serverCode]) {
        return res.status(404).json({ error: "No scheduled shutdown found" });
    }

    delete scheduledShutdowns[serverCode];
    res.json({ success: true, message: "Scheduled shutdown cancelled" });
});

app.get('/api/servers/:serverCode/players', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "Server not found" });
    
    const schedule = scheduledShutdowns[serverCode] || null;
    res.json({
        ...serverData,
        scheduledShutdown: schedule ? { time: schedule.formattedTime, timestamp: schedule.executeAt } : null
    });
});

app.get('/api/servers/:serverCode/players/:playerId', verifyAdminAccess, (req, res) => {
    const { serverCode, playerId } = req.params;
    const serverData = liveServers[serverCode];
    if (!serverData) return res.status(404).json({ error: "Server not found" });

    const player = serverData.players.find(p => String(p.userId) === String(playerId) || p.name === playerId);
    if (!player) return res.status(404).json({ error: "Player not found" });

    res.json(player);
});

app.get('/api/avatar/:userId', async (req, res) => {
    try {
        const response = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=false`);
        const data = await response.json();
        if (data && data.data && data.data.length > 0 && data.data[0].state === "Completed") {
            return res.redirect(data.data[0].imageUrl);
        }
        res.redirect("https://tr.rbxcdn.com/3b43a29ce73ed72b47b2c554a938c5d6/150/150/AvatarHeadshot/Png");
    } catch (error) {
        res.redirect("https://tr.rbxcdn.com/3b43a29ce73ed72b47b2c554a938c5d6/150/150/AvatarHeadshot/Png");
    }
});

setInterval(() => {
    const now = Date.now();
    Object.keys(oauthStates).forEach(k => {
        if(now - oauthStates[k].time > 600000) delete oauthStates[k];
    });

    Object.keys(liveServers).forEach(serverCode => {
        if (now - liveServers[serverCode].lastUpdated > 7000) {
            delete liveServers[serverCode];
            delete commandsQueue[serverCode];
            delete scheduledShutdowns[serverCode];

            Object.values(activeAdmins).forEach(admin => {
                if (admin.serverCode === serverCode) {
                    admin.status = "Online";
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
                    reason: "Scheduled",
                    duration: 0,
                    senderId: scheduledShutdowns[serverCode].senderId
                 });
                delete scheduledShutdowns[serverCode];
            }
        }
    });
}, 3000);

app.use((err, req, res, next) => {
    res.status(500).json({ error: "Internal Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));