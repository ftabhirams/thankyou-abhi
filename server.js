const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// Use built-in fetch (Requires Node.js 18+)
app.use(express.static('public'));

const rooms = {}; 

io.on('connection', (socket) => {
  
  // Secure Room Joining & Authentication
  socket.on('join-room', (data) => {
    const { roomId, password } = data;
    
    if (!rooms[roomId]) {
      // Create new room with password
      rooms[roomId] = { 
          currentVideo: { id: 'dQw4w9WgXcQ', type: 'youtube' }, 
          queue: [],
          host: socket.id,
          password: password || '' 
      };
    } else {
      // Check password if room exists
      if (rooms[roomId].password !== '' && rooms[roomId].password !== password) {
          socket.emit('auth-error', 'Incorrect password');
          return;
      }
    }

    socket.join(roomId);
    socket.emit('auth-success', roomId);
    socket.emit('role-assignment', { isHost: rooms[roomId].host === socket.id });
    socket.to(roomId).emit('user-connected', socket.id);
    
    socket.emit('queue-updated', rooms[roomId].queue);
    socket.emit('force-video-change', rooms[roomId].currentVideo);

    // =====================================
    // MEDIA & QUEUE SYNC
    // =====================================
    
    socket.on('add-to-queue', async (videoId) => {
      if (typeof videoId !== 'string' || videoId.length > 200 || rooms[roomId].queue.length >= 50) return;

      // Fetch YouTube Title dynamically
      let title = "Unknown Video";
      try {
          const response = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
          const data = await response.json();
          if (data.title) title = data.title;
      } catch (e) { console.error("Could not fetch title"); }

      rooms[roomId].queue.push({ id: videoId, title: title });
      io.to(roomId).emit('queue-updated', rooms[roomId].queue);
    });

    // Host-Only: Play specific song from queue
    socket.on('play-from-queue', (index) => {
        if (rooms[roomId].host === socket.id && rooms[roomId].queue[index]) {
            const selectedVideo = rooms[roomId].queue.splice(index, 1)[0];
            rooms[roomId].currentVideo = { id: selectedVideo.id, type: 'youtube' };
            io.to(roomId).emit('force-video-change', rooms[roomId].currentVideo);
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        }
    });

    socket.on('video-ended', (finishedVideoId) => {
      if (rooms[roomId].currentVideo.id === finishedVideoId && rooms[roomId].queue.length > 0) {
          const nextVideo = rooms[roomId].queue.shift();
          rooms[roomId].currentVideo = { id: nextVideo.id, type: 'youtube' };
          io.to(roomId).emit('force-video-change', rooms[roomId].currentVideo);
          io.to(roomId).emit('queue-updated', rooms[roomId].queue);
      }
    });

    // Timeline Scrubbing & Play/Pause (Host Only)
    socket.on('sync-video', (data) => {
      if (rooms[roomId].host === socket.id) socket.to(roomId).emit('update-video', data);
    });

    socket.on('load-movie', (url) => {
      if (typeof url !== 'string' || url.length > 1000) return;
      if (rooms[roomId].host === socket.id) {
          rooms[roomId].currentVideo = { id: url, type: 'html5' };
          io.to(roomId).emit('force-video-change', rooms[roomId].currentVideo);
      }
    });

    socket.on('sync-movie', (data) => {
      if (rooms[roomId].host === socket.id) socket.to(roomId).emit('sync-movie', data);
    });

    // =====================================
    // CHAT & WEBRTC
    // =====================================
    socket.on('send-chat', (message) => {
      if (typeof message !== 'string' || message.length > 1000) return;
      io.to(roomId).emit('receive-chat', message, socket.id);
    });
    
    socket.on('webrtc-offer', (offer, targetId) => io.to(targetId).emit('webrtc-offer', offer, socket.id));
    socket.on('webrtc-answer', (answer, targetId) => io.to(targetId).emit('webrtc-answer', answer, socket.id));
    socket.on('webrtc-ice-candidate', (candidate, targetId) => io.to(targetId).emit('webrtc-ice-candidate', candidate, socket.id));

    socket.on('disconnect', () => {
      socket.to(roomId).emit('user-disconnected', socket.id);
      const currentRoom = io.sockets.adapter.rooms.get(roomId);
      
      if (!currentRoom || currentRoom.size === 0) {
          delete rooms[roomId]; 
      } else if (rooms[roomId] && rooms[roomId].host === socket.id) {
          const newHostId = Array.from(currentRoom)[0];
          rooms[roomId].host = newHostId;
          io.to(roomId).emit('new-host', newHostId);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
