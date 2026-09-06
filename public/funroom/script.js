const socket = io('/');
let ROOM_ID = '';
let localStream;
let screenStream = null;
const peers = {}; 
let isMyHost = false; 

const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
}

// ==========================================
// 1. AUTHENTICATION & HARDWARE
// ==========================================
function joinRoom() {
    const nameInput = document.getElementById('room-name').value.trim();
    const passInput = document.getElementById('room-pass').value;
    
    if (!nameInput) {
        document.getElementById('auth-err').innerText = "Room name required";
        return;
    }
    
    ROOM_ID = nameInput;
    socket.emit('join-room', { roomId: ROOM_ID, password: passInput });
}

socket.on('auth-error', (msg) => {
    document.getElementById('auth-err').innerText = msg;
});

socket.on('auth-success', (roomId) => {
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('main-app').style.display = 'flex';
    document.getElementById('room-display-name').innerText = `(${roomId})`;
    
    navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(stream => {
        localStream = stream;
        document.getElementById('my-video').srcObject = stream;
    }).catch(err => alert("Camera/Mic access denied. You can still watch and chat!"));
});

function toggleCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    const btn = document.getElementById('cam-btn');
    btn.innerText = videoTrack.enabled ? "📷 Cam On" : "🚫 Cam Off";
    btn.classList.toggle('off', !videoTrack.enabled);
}

function toggleMic() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    const btn = document.getElementById('mic-btn');
    btn.innerText = audioTrack.enabled ? "🎤 Mic On" : "🔇 Mic Off";
    btn.classList.toggle('off', !audioTrack.enabled);
}

function toggleFullScreen() {
    const wrapper = document.getElementById('media-wrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(err => console.log("Fullscreen blocked"));
    } else {
        document.exitFullscreen();
    }
}

// ==========================================
// 2. HOST CONTROLS
// ==========================================
socket.on('role-assignment', (data) => {
    isMyHost = data.isHost;
    updateHostUI();
});

socket.on('new-host', (newHostId) => {
    isMyHost = (newHostId === socket.id);
    updateHostUI();
});

function updateHostUI() {
    document.getElementById('host-badge').style.display = isMyHost ? 'inline-block' : 'none';
    document.getElementById('direct-video-container').style.display = isMyHost ? 'flex' : 'none';
    
    if (isMyHost) {
        document.body.classList.add('host-mode');
    } else {
        document.body.classList.remove('host-mode');
    }
}

// ==========================================
// 3. WEBRTC MESH NETWORK
// ==========================================
function createPeerConnection(targetUserId) {
    const pc = new RTCPeerConnection(servers);
    peers[targetUserId] = pc;

    if (localStream) {
        const activeStream = screenStream ? screenStream : localStream;
        activeStream.getTracks().forEach(track => pc.addTrack(track, activeStream));
    }

    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc-ice-candidate', e.candidate, targetUserId); };

    pc.ontrack = (event) => {
        let wrapper = document.getElementById(`wrapper-${targetUserId}`);
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = `wrapper-${targetUserId}`;
            wrapper.className = 'video-wrapper';
            
            const friendVideo = document.createElement('video');
            friendVideo.id = `video-${targetUserId}`;
            friendVideo.autoplay = true; friendVideo.playsInline = true;
            
            wrapper.appendChild(friendVideo);
            document.getElementById('video-grid').appendChild(wrapper);
        }
        document.getElementById(`video-${targetUserId}`).srcObject = event.streams[0];
    };
    return pc;
}

socket.on('user-connected', async (userId) => {
    if(!localStream) return;
    const pc = createPeerConnection(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', offer, userId);
});

socket.on('webrtc-offer', async (offer, senderId) => {
    const pc = createPeerConnection(senderId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', answer, senderId);
});

socket.on('webrtc-answer', async (answer, senderId) => {
    if (peers[senderId]) await peers[senderId].setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('webrtc-ice-candidate', async (c, senderId) => {
    if (peers[senderId]) await peers[senderId].addIceCandidate(new RTCIceCandidate(c));
});

socket.on('user-disconnected', (userId) => {
    if (peers[userId]) { peers[userId].close(); delete peers[userId]; }
    const wrapper = document.getElementById(`wrapper-${userId}`);
    if (wrapper) wrapper.remove();
});

async function toggleScreenShare() {
    const btn = document.getElementById('screen-share-btn');
    if (screenStream) { stopScreenShare(); return; }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        document.getElementById('my-video').srcObject = screenStream;
        btn.innerText = "🛑 Stop Sharing"; btn.style.background = "var(--danger)";

        for (let userId in peers) {
            const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(screenVideoTrack);
        }
        screenVideoTrack.onended = () => stopScreenShare();
    } catch (err) {}
}

function stopScreenShare() {
    if (!screenStream) return;
    const btn = document.getElementById('screen-share-btn');
    document.getElementById('my-video').srcObject = localStream;
    btn.innerText = "🖥️ Share Screen"; btn.style.background = "var(--secondary)";

    if (localStream) {
        const cameraTrack = localStream.getVideoTracks()[0];
        for (let userId in peers) {
            const videoSender = peers[userId].getSenders().find(s => s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(cameraTrack);
        }
    }
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
}

// ==========================================
// 4. YOUTUBE & CLICK-TO-PLAY QUEUE
// ==========================================
let player;
let isHostInitiated = false;

function onYouTubeIframeAPIReady() {
    player = new YT.Player('yt-player', {
        videoId: '', 
        events: { 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerStateChange(event) {
    if (isHostInitiated && isMyHost) {
        socket.emit('sync-video', { state: event.data, time: player.getCurrentTime() });
        isHostInitiated = false; 
    }
    if (event.data === YT.PlayerState.ENDED && isMyHost) {
        socket.emit('video-ended', player.getVideoData().video_id);
    }
}

document.getElementById('yt-player-container').addEventListener('click', () => { isHostInitiated = true; });
document.getElementById('yt-player-container').addEventListener('mousedown', () => { isHostInitiated = true; }); 

socket.on('update-video', (data) => {
    if (!player || isMyHost) return; 
    
    if (Math.abs(player.getCurrentTime() - data.time) > 2) {
        player.seekTo(data.time);
    }
    
    if (data.state === YT.PlayerState.PLAYING) player.playVideo();
    else if (data.state === YT.PlayerState.PAUSED) player.pauseVideo();
});

function addToQueue() {
    const input = document.getElementById('video-id-input');
    let id = input.value.trim();
    if (id.includes('v=')) id = id.split('v=')[1].substring(0, 11);
    else if (id.includes('youtu.be/')) id = id.split('youtu.be/')[1].substring(0, 11);

    if (id) {
        socket.emit('add-to-queue', id);
        input.value = ''; 
    }
}

function playFromQueue(index) {
    if (isMyHost) socket.emit('play-from-queue', index);
}

socket.on('queue-updated', (queue) => {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    if (queue.length === 0) {
        queueList.innerHTML = '<li style="border:none; background:transparent;">Queue is empty</li>';
    } else {
        queue.forEach((video, index) => {
            const safeTitle = escapeHTML(video.title);
            queueList.innerHTML += `
                <li>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;">
                        ${index + 1}. ${safeTitle}
                    </span>
                    <button class="play-queue-btn" onclick="playFromQueue(${index})">▶ Play</button>
                </li>`;
        });
    }
});

socket.on('force-video-change', (mediaObj) => {
    const ytContainer = document.getElementById('yt-player-container');
    const html5Container = document.getElementById('html5-player-container');
    const html5Video = document.getElementById('html5-video');

    if (mediaObj.type === 'youtube') {
        ytContainer.style.display = 'block';
        html5Container.style.display = 'none';
        if (!html5Video.paused) html5Video.pause();
        if (player && player.loadVideoById) player.loadVideoById(mediaObj.id);
    } 
    else if (mediaObj.type === 'html5') {
        ytContainer.style.display = 'none';
        html5Container.style.display = 'block';
        if (player && player.pauseVideo) player.pauseVideo();
        html5Video.src = mediaObj.id;
        html5Video.play().catch(e => console.log("Autoplay blocked"));
    }
});

// ==========================================
// 5. HTML5 MOVIE LOGIC
// ==========================================
const html5Video = document.getElementById('html5-video');
let isRemoteAction = false; 

function loadDirectMovie() {
    if (!isMyHost) return; 
    const url = document.getElementById('direct-video-input').value.trim();
    if(url) { socket.emit('load-movie', url); document.getElementById('direct-video-input').value = ''; }
}

html5Video.addEventListener('play', () => { if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'play', time: html5Video.currentTime }); });
html5Video.addEventListener('pause', () => { if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'pause', time: html5Video.currentTime }); });
html5Video.addEventListener('seeked', () => { if (!isRemoteAction && isMyHost) socket.emit('sync-movie', { state: 'seek', time: html5Video.currentTime }); });

socket.on('sync-movie', (data) => {
    isRemoteAction = true; 
    if (Math.abs(html5Video.currentTime - data.time) > 1) html5Video.currentTime = data.time;
    if (data.state === 'play') html5Video.play();
    if (data.state === 'pause') html5Video.pause();
    setTimeout(() => { isRemoteAction = false; }, 50);
});

// ==========================================
// 6. CHAT
// ==========================================
function handleChat(e) {
    if (e.key === 'Enter' && e.target.value.trim() !== '') {
        socket.emit('send-chat', e.target.value.trim());
        e.target.value = '';
    }
}

socket.on('receive-chat', (msg, senderId) => {
    const chatBox = document.getElementById('chat-box');
    const isMe = senderId === socket.id;
    chatBox.innerHTML += `<div class="chat-msg ${isMe ? 'self' : ''}"><b>${isMe ? 'You' : 'Friend'}</b> ${escapeHTML(msg)}</div>`;
    chatBox.scrollTop = chatBox.scrollHeight;
});
