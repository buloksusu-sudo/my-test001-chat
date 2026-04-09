import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const adjectives = ['행복한', '졸린', '배고픈', '신난', '용감한', '똑똑한', '귀여운', '멋진', '친절한', '빠른', '느긋한', '빛나는', '작은', '커다란', '푸른'];
const animals = ['망고', '고양이', '강아지', '호랑이', '사자', '판다', '여우', '토끼', '곰', '다람쥐', '거북이', '펭귄', '코끼리', '기린', '원숭이'];

function generateNickname() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const ani = animals[Math.floor(Math.random() * animals.length)];
  return `${adj} ${ani}`;
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
    },
    maxHttpBufferSize: 1e8, // 100MB for file transfers via socket if needed
  });

  const PORT = process.env.PORT || 3000;

  // Room State
  let roomLocked = false;
  let users: { id: string; nickname: string; isHost: boolean }[] = [];

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    if (roomLocked) {
      socket.emit('error', '방이 잠겨 있습니다.');
      socket.disconnect();
      return;
    }

    const nickname = generateNickname();
    const isHost = users.length === 0;
    const newUser = { id: socket.id, nickname, isHost };
    users.push(newUser);

    socket.emit('init', { user: newUser, users, roomLocked });
    socket.broadcast.emit('user-joined', newUser);

    socket.on('message', (data) => {
      // XSS prevention is handled on client side by React, 
      // but we broadcast the message to everyone.
      io.emit('message', {
        id: Date.now().toString(),
        senderId: socket.id,
        senderName: nickname,
        text: data.text,
        type: 'text',
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('file', (data) => {
      io.emit('message', {
        id: Date.now().toString(),
        senderId: socket.id,
        senderName: nickname,
        fileName: data.fileName,
        fileType: data.fileType,
        fileData: data.fileData, // base64
        type: 'file',
        timestamp: new Date().toISOString(),
      });
    });

    // WebRTC Signaling
    socket.on('webrtc-offer', (data) => {
      socket.to(data.target).emit('webrtc-offer', {
        offer: data.offer,
        sender: socket.id,
      });
    });

    socket.on('webrtc-answer', (data) => {
      socket.to(data.target).emit('webrtc-answer', {
        answer: data.answer,
        sender: socket.id,
      });
    });

    socket.on('webrtc-ice-candidate', (data) => {
      socket.to(data.target).emit('webrtc-ice-candidate', {
        candidate: data.candidate,
        sender: socket.id,
      });
    });

    // Host Controls
    socket.on('kick', (targetId) => {
      const user = users.find(u => u.id === socket.id);
      if (user?.isHost) {
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
          targetSocket.emit('kicked');
          targetSocket.disconnect();
        }
      }
    });

    socket.on('toggle-lock', () => {
      const user = users.find(u => u.id === socket.id);
      if (user?.isHost) {
        roomLocked = !roomLocked;
        io.emit('room-lock-changed', roomLocked);
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      const index = users.findIndex(u => u.id === socket.id);
      if (index !== -1) {
        const wasHost = users[index].isHost;
        users.splice(index, 1);

        if (wasHost && users.length > 0) {
          users[0].isHost = true;
          io.emit('host-changed', users[0].id);
        }

        io.emit('user-left', socket.id);
      }
    });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
