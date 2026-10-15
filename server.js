require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;

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

let mongoClient = null;
let usersCollection = null;
let messagesCollection = null;
const memoryUsers = new Map();
const memoryMessages = [];
const onlineUsers = new Map();

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI is not set. Using temporary in-memory storage; data will be lost when the service restarts.");
    return;
  }
  mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  const database = mongoClient.db(process.env.MONGODB_DB || "dchat");
  usersCollection = database.collection("users");
  messagesCollection = database.collection("messages");
  await usersCollection.createIndex({ username: 1 }, { unique: true });
  await messagesCollection.createIndex({ from: 1, to: 1, createdAt: 1 });
  console.log("Connected to MongoDB.");
}

function publicUser(user) {
  return { username: user.username, createdAt: user.createdAt };
}

function makeToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
}

async function findUser(username) {
  return usersCollection
    ? usersCollection.findOne({ username })
    : memoryUsers.get(username) || null;
}

async function saveUser(user) {
  if (usersCollection) await usersCollection.insertOne(user);
  else memoryUsers.set(user.username, user);
}

async function listUsers() {
  if (usersCollection) return usersCollection.find({}, { projection: { _id: 0, username: 1, createdAt: 1 } }).toArray();
  return [...memoryUsers.values()].map(publicUser);
}

async function saveMessage(message) {
  if (messagesCollection) await messagesCollection.insertOne(message);
  else memoryMessages.push(message);
}

async function getConversation(a, b) {
  if (messagesCollection) {
    return messagesCollection.find({
      $or: [{ from: a, to: b }, { from: b, to: a }]
    }, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(2000).toArray();
  }
  return memoryMessages.filter((m) =>
    (m.from === a && m.to === b) || (m.from === b && m.to === a)
  );
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
  res.json({ ok: true, service: "DChat Server" });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–24 characters and use letters, numbers, _, . or -." });
    }
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (await findUser(username)) return res.status(409).json({ error: "Username already exists." });

    const user = {
      username,
      passwordHash: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };
    try {
      await saveUser(user);
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ error: "Username already exists." });
      throw error;
    }
    return res.status(201).json({
      ok: true,
      token: makeToken(username),
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const user = await findUser(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    return res.json({ ok: true, token: makeToken(username), user: publicUser(user) });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const user = await findUser(req.user.username);
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ user: publicUser(user) });
});

app.get("/api/users", requireAuth, async (req, res) => {
  try {
    const users = await listUsers();
    res.json(users.filter((u) => u.username !== req.user.username).map((u) => ({
      ...u,
      online: (onlineUsers.get(u.username) || 0) > 0
    })));
  } catch (error) {
    console.error("Users error:", error);
    res.status(500).json({ error: "Could not load users." });
  }
});

app.get("/api/messages/:username", requireAuth, async (req, res) => {
  try {
    const other = String(req.params.username || "").trim();
    if (!await findUser(other)) return res.status(404).json({ error: "User not found." });
    const messages = await getConversation(req.user.username, other);
    res.json(messages);
  } catch (error) {
    console.error("Messages error:", error);
    res.status(500).json({ error: "Could not load messages." });
  }
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
      const to = String(payload?.to || payload?.recipient || "").trim();
      const body = String(payload?.text || "").trim();
      if (!to || to === username) {
        return typeof acknowledge === "function" && acknowledge({ ok: false, error: "Choose another user." });
      }
      if (!body || body.length > 5000) {
        return typeof acknowledge === "function" && acknowledge({ ok: false, error: "Message must contain 1–5000 characters." });
      }
      if (!await findUser(to)) {
        return typeof acknowledge === "function" && acknowledge({ ok: false, error: "Recipient not found." });
      }

      const message = {
        id: randomUUID(),
        from: username,
        to,
        text: body,
        createdAt: new Date().toISOString()
      };
      await saveMessage(message);
      io.to(`user:${username}`).emit("message:new", message);
      io.to(`user:${to}`).emit("message:new", message);
      if (typeof acknowledge === "function") acknowledge({ ok: true, message });
    } catch (error) {
      console.error("Send message error:", error);
      if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Message could not be sent." });
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

connectDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => console.log(`DChat server listening on port ${PORT}`));
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
    process.exit(1);
  });
