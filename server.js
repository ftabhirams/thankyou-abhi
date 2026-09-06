const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = {}; 

io.on('connection', (socket) => {
  
  socket.on('create-room', (password) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    
    rooms[roomId] = { 
        currentVideo: { id: 'dQw4w9WgXcQ', type: 'youtube' }, 
        queue: [],
        host: socket.id,
        password: password || '' 
    };

    socket.join(roomId);
    socket.emit('auth-success', roomId);
    socket.emit('role-assignment', { isHost: true });
    socket.emit('queue-updated', rooms[roomId].queue);
    socket.emit('force-video-change', rooms[roomId].currentVideo);
  });

  socket.on('join-room', (data) => {
    const { roomId, password } = data;
    const roomCode = roomId.toUpperCase();
    
    if (!rooms[roomCode]) {
        socket.emit('auth-error', 'Room does not exist.');
        return;
    }
    
    if (rooms[roomCode].password !== '' && rooms[roomCode].password !== password) {
        socket.emit('auth-error', 'Incorrect password.');
        return;
    }

    socket.join(roomCode);
    socket.emit('auth-success', roomCode);
    socket.emit('role-assignment', { isHost: rooms[roomCode].host === socket.id });
    
    // NOTE: We no longer emit user-connected here! We wait for their camera.
    
    socket.emit('queue-updated', rooms[roomCode].queue);
    socket.emit('force-video-change', rooms[roomCode].currentVideo);
  });

  // PATCH: Only connect users AFTER their camera resolves
  socket.on('room-ready', (roomId) => {
      socket.to(roomId).emit('user-connected', socket.id);
  });

  // =====================================
  // MEDIA & QUEUE SYNC
  // =====================================
  socket.on('add-to-queue', async (data) => {
    const { roomId, videoId } = data;
    if (!rooms[roomId] || typeof videoId !== 'string' || videoId.length > 200 || rooms[roomId].queue.length >= 50) return;

    let title = "Unknown Video";
    try {
        const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
        const json = await response.json();
        if (json.title) title = json.title;
    } catch (e) {}

    rooms[roomId].queue.push({ id: videoId, title: title });
    io.to(roomId).emit('queue-updated', rooms[roomId].queue);
  });

  socket.on('play-from-queue', (data) => {
      const { roomId, index } = data;
      if (rooms[roomId] && rooms[roomId].host === socket.id && rooms[roomId].queue[index]) {
          const selectedVideo = rooms[roomId].queue.splice(index, 1)[0];
          rooms[roomId].currentVideo = { id: selectedVideo.id, type: 'youtube' };
          io.to(roomId).emit('force-video-change', rooms[roomId].currentVideo);
          io.to(roomId).emit('queue-updated', rooms[roomId].queue);
      }
  });

  socket.on('video-ended', (roomId, finishedVideoId) => {
    if (rooms[roomId] && rooms[roomId].currentVideo.id === finishedVideoId && rooms[roomId].queue.length > 0) {
        const nextVideo = rooms[roomId].queue.shift();
        rooms[roomId].currentVideo = { id: nextVideo.id, type: 'youtube' };
        io.to(roomId).emit('force-video-change', rooms[roomId].currentVideo);
        io.to(roomId).emit('queue-updated', rooms[roomId].queue);
    }
  });

  socket.on('sync-video', (data) => {
    if (rooms[data.roomId] && rooms[data.roomId].host === socket.id) socket.to(data.roomId).emit('update-video', data);
  });

  socket.on('load-movie', (data) => {
    if (!rooms[data.roomId] || typeof data.url !== 'string' || data.url.length > 1000) return;
    if (rooms[data.roomId].host === socket.id) {
        rooms[data.roomId].currentVideo = { id: data.url, type: 'html5' };
        io.to(data.roomId).emit('force-video-change', rooms[data.roomId].currentVideo);
    }
  });

  socket.on('sync-movie', (data) => {
    if (rooms[data.roomId] && rooms[data.roomId].host === socket.id) socket.to(data.roomId).emit('sync-movie', data);
  });

  // =====================================
  // CHAT & WEBRTC
  // =====================================
  socket.on('send-chat', (data) => {
    if (typeof data.message !== 'string' || data.message.length > 1000) return;
    io.to(data.roomId).emit('receive-chat', data.message, socket.id);
  });
  
  socket.on('webrtc-offer', (offer, targetId) => io.to(targetId).emit('webrtc-offer', offer, socket.id));
  socket.on('webrtc-answer', (answer, targetId) => io.to(targetId).emit('webrtc-answer', answer, socket.id));
  socket.on('webrtc-ice-candidate', (candidate, targetId) => io.to(targetId).emit('webrtc-ice-candidate', candidate, socket.id));

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const currentRoomSockets = io.sockets.adapter.rooms.get(roomId);
        
        if (currentRoomSockets && currentRoomSockets.has(socket.id)) {
            socket.to(roomId).emit('user-disconnected', socket.id);
            if (room.host === socket.id && currentRoomSockets.size > 1) {
                const remainingUsers = Array.from(currentRoomSockets).filter(id => id !== socket.id);
                if (remainingUsers.length > 0) {
                    room.host = remainingUsers[0];
                    io.to(roomId).emit('new-host', room.host);
                }
            }
        }
    }
    
    for (const roomId in rooms) {
        const r = io.sockets.adapter.rooms.get(roomId);
        if (!r || r.size === 0) delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
