require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "dchat-data.json");

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("Set JWT_SECRET to a random secret of at least 32 characters in Render environment variables.");
  process.exit(1);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const onlineUsers = new Map();
let users = [];
let messages = [];
let writeQueue = Promise.resolve();

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    users = Array.isArray(data.users) ? data.users : [];
    messages = Array.isArray(data.messages) ? data.messages : [];
    console.log(`Loaded ${users.length} users and ${messages.length} messages from local JSON storage.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persistData();
    console.log("Created a new local JSON data file.");
  }
}

function persistData() {
  const snapshot = JSON.stringify({ users, messages }, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tempFile = DATA_FILE + ".tmp";
    await fs.writeFile(tempFile, snapshot, "utf8");
    await fs.rename(tempFile, DATA_FILE);
  });
  return writeQueue;
}

function publicUser(user) {
  return { username: user.username, createdAt: user.createdAt };
}

function makeToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
}

function findUser(username) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("DChat Server is running. See /health.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "DChat Server", storage: "local-json" });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–24 characters and use letters, numbers, _, . or -." });
    }
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (findUser(username)) return res.status(409).json({ error: "Username already exists." });

    const user = {
      username,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };
    users.push(user);
    await persistData();

    return res.status(201).json({
      ok: true,
      token: makeToken(username),
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const user = findUser(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    res.json({ ok: true, token: makeToken(user.username), user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = findUser(req.user.username);
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ user: publicUser(user) });
});

app.get("/api/users", requireAuth, (req, res) => {
  const currentUsername = String(req.user?.username || "").toLowerCase();
  const list = users
    .filter((user) => user.username.toLowerCase() !== currentUsername)
    .map((user) => ({
      ...publicUser(user),
      online: (onlineUsers.get(user.username) || 0) > 0
    }));

  // Keep the response contract consistent with the Flutter client.
  res.status(200).json({ ok: true, users: list });
});

app.get("/api/messages/:username", requireAuth, (req, res) => {
  const other = String(req.params.username || "").trim();
  if (!findUser(other)) return res.status(404).json({ error: "User not found." });
  const conversation = messages.filter((m) =>
    (m.from === req.user.username && m.to.toLowerCase() === other.toLowerCase()) ||
    (m.to.toLowerCase() === req.user.username.toLowerCase() && m.from.toLowerCase() === other.toLowerCase())
  );
  res.status(200).json({ ok: true, messages: conversation.slice(-2000) });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  const username = socket.user.username;
  socket.join(`user:${username}`);
  onlineUsers.set(username, (onlineUsers.get(username) || 0) + 1);
  io.emit("presence:update", { username, online: true });

  socket.on("message:send", async (payload, acknowledge) => {
    try {
      const toInput = String(payload?.to || payload?.recipient || "").trim();
      const recipient = findUser(toInput);
      const body = String(payload?.text || "").trim();

      if (!recipient || recipient.username.toLowerCase() === username.toLowerCase()) {
        if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Choose a valid recipient." });
        return;
      }
      if (!body || body.length > 5000) {
        if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Message must contain 1–5000 characters." });
        return;
      }

      const message = {
        id: randomUUID(),
        from: username,
        to: recipient.username,
        text: body,
        createdAt: new Date().toISOString()
      };
      messages.push(message);
      await persistData();

      io.to(`user:${username}`).emit("message:new", message);
      io.to(`user:${recipient.username}`).emit("message:new", message);
      if (typeof acknowledge === "function") acknowledge({ ok: true, message });
    } catch (error) {
      console.error("Send message error:", error);
      if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Message could not be saved or sent." });
    }
  });

  socket.on("disconnect", () => {
    const count = Math.max(0, (onlineUsers.get(username) || 1) - 1);
    if (count === 0) {
      onlineUsers.delete(username);
      io.emit("presence:update", { username, online: false });
    } else {
      onlineUsers.set(username, count);
    }
  });
});

process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

loadData()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log(`DChat server listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error("Could not load local JSON data:", error);
    process.exit(1);
  });
