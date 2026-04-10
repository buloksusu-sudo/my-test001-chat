import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Send, 
  File as FileIcon, 
  Users, 
  Lock, 
  Unlock, 
  UserX, 
  Shield, 
  Download,
  MessageSquare,
  X,
  Menu
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface User {
  id: string;
  nickname: string;
  isHost: boolean;
}

interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text?: string;
  fileName?: string;
  fileType?: string;
  fileData?: string; // base64
  type: 'text' | 'file' | 'system';
  timestamp: string;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [roomLocked, setRoomLocked] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isP2P, setIsP2P] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; message: Message }[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notifyRef = useRef<(message: Message) => void>(() => {});
  const unreadCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Document Title & Unread Count
  useEffect(() => {
    const handleFocus = () => {
      unreadCountRef.current = 0;
      document.title = "망고가족-챗";
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Request Notification Permission
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    // Preload sound
    audioRef.current = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const notifyNewMessage = useCallback((message: Message) => {
    if (message.senderId === currentUser?.id || message.type === 'system') return;

    // Play sound
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.log('Audio play failed:', e));
    }

    // Update Title
    if (document.visibilityState === 'hidden') {
      unreadCountRef.current += 1;
      document.title = `(${unreadCountRef.current}) 새로운 메시지`;
    }

    // Add In-app Toast
    const toastId = Math.random().toString();
    setToasts(prev => [...prev, { id: toastId, message }]);
    setTimeout(() => removeToast(toastId), 5000);

    // Show browser notification if tab is hidden
    if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const title = `${message.senderName}님의 메시지`;
        const options = {
          body: message.type === 'text' ? message.text : `파일 전송: ${message.fileName}`,
          icon: '/favicon.ico'
        };
        new Notification(title, options);
      } catch (e) {
        console.log('Notification failed:', e);
      }
    }
  }, [currentUser?.id]);

  // Keep notifyRef updated with the latest notifyNewMessage
  useEffect(() => {
    notifyRef.current = notifyNewMessage;
  }, [notifyNewMessage]);

  // Socket setup
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('init', ({ user, users, roomLocked }) => {
      setCurrentUser(user);
      setUsers(users);
      setRoomLocked(roomLocked);
      addSystemMessage(`채팅방에 참여했습니다. 닉네임: ${user.nickname}`);
    });

    newSocket.on('user-joined', (user: User) => {
      setUsers(prev => [...prev, user]);
      addSystemMessage(`${user.nickname}님이 입장했습니다.`);
    });

    newSocket.on('user-left', (userId: string) => {
      setUsers(prev => {
        const user = prev.find(u => u.id === userId);
        if (user) addSystemMessage(`${user.nickname}님이 퇴장했습니다.`);
        return prev.filter(u => u.id !== userId);
      });
    });

    newSocket.on('host-changed', (hostId: string) => {
      setUsers(prev => prev.map(u => ({ ...u, isHost: u.id === hostId })));
      if (newSocket.id === hostId) {
        setCurrentUser(prev => prev ? { ...prev, isHost: true } : null);
        addSystemMessage('당신이 이제 방장입니다.');
      }
    });

    newSocket.on('message', (message: Message) => {
      setMessages(prev => [...prev, message]);
      notifyRef.current(message);
    });

    newSocket.on('room-lock-changed', (locked: boolean) => {
      setRoomLocked(locked);
      addSystemMessage(locked ? '방이 잠겼습니다.' : '방 잠금이 해제되었습니다.');
    });

    newSocket.on('kicked', () => {
      alert('방장에 의해 강퇴되었습니다.');
      window.location.reload();
    });

    newSocket.on('error', (msg: string) => {
      alert(msg);
    });

    // WebRTC Signaling
    newSocket.on('webrtc-offer', async ({ offer, sender }) => {
      if (!pcRef.current) setupWebRTC(false, sender);
      await pcRef.current?.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pcRef.current?.createAnswer();
      await pcRef.current?.setLocalDescription(answer!);
      newSocket.emit('webrtc-answer', { answer, target: sender });
    });

    newSocket.on('webrtc-answer', async ({ answer }) => {
      await pcRef.current?.setRemoteDescription(new RTCSessionDescription(answer));
    });

    newSocket.on('webrtc-ice-candidate', async ({ candidate }) => {
      if (candidate) {
        await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    return () => {
      newSocket.disconnect();
      closeWebRTC();
    };
  }, []);

  // WebRTC Management
  useEffect(() => {
    if (users.length === 2) {
      setIsP2P(true);
      const host = users.find(u => u.isHost);
      if (currentUser?.id === host?.id) {
        const otherUser = users.find(u => u.id !== currentUser.id);
        if (otherUser) {
          setupWebRTC(true, otherUser.id);
        }
      }
    } else {
      setIsP2P(false);
      closeWebRTC();
    }
  }, [users.length, currentUser?.id]);

  const setupWebRTC = (isInitiator: boolean, targetId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket?.emit('webrtc-ice-candidate', { candidate: event.candidate, target: targetId });
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('chat');
      setupDataChannel(dc);
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket?.emit('webrtc-offer', { offer, target: targetId });
      });
    } else {
      pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }
  };

  const setupDataChannel = (dc: RTCDataChannel) => {
    dataChannelRef.current = dc;
    dc.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setMessages(prev => [...prev, data]);
      notifyRef.current(data);
    };
  };

  const closeWebRTC = () => {
    dataChannelRef.current?.close();
    pcRef.current?.close();
    dataChannelRef.current = null;
    pcRef.current = null;
  };

  const addSystemMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: Math.random().toString(),
      senderId: 'system',
      senderName: 'System',
      text,
      type: 'system',
      timestamp: new Date().toISOString()
    }]);
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || !currentUser) return;

    if (users.length <= 1) {
      addSystemMessage('대화방에 대화 상대가 없습니다. 다른 사용자가 접속할 때까지 기다려주세요.');
      setInputText('');
      return;
    }

    const messageData: Message = {
      id: Date.now().toString(),
      senderId: currentUser.id,
      senderName: currentUser.nickname,
      text: inputText,
      type: 'text',
      timestamp: new Date().toISOString()
    };

    if (isP2P && dataChannelRef.current?.readyState === 'open') {
      dataChannelRef.current.send(JSON.stringify(messageData));
      setMessages(prev => [...prev, messageData]);
    } else {
      socket?.emit('message', { text: inputText });
    }

    setInputText('');
  };

  const handleFileUpload = async (file: File) => {
    if (!currentUser) return;

    if (users.length <= 1) {
      addSystemMessage('대화방에 대화 상대가 없습니다. 파일을 보낼 상대가 접속할 때까지 기다려주세요.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Data = e.target?.result as string;
      const messageData: Message = {
        id: Date.now().toString(),
        senderId: currentUser.id,
        senderName: currentUser.nickname,
        fileName: file.name,
        fileType: file.type,
        fileData: base64Data,
        type: 'file',
        timestamp: new Date().toISOString()
      };

      if (isP2P && dataChannelRef.current?.readyState === 'open') {
        dataChannelRef.current.send(JSON.stringify(messageData));
        setMessages(prev => [...prev, messageData]);
      } else {
        socket?.emit('file', {
          fileName: file.name,
          fileType: file.type,
          fileData: base64Data
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  const kickUser = (id: string) => {
    if (currentUser?.isHost) {
      socket?.emit('kick', id);
    }
  };

  const toggleLock = () => {
    if (currentUser?.isHost) {
      socket?.emit('toggle-lock');
    }
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden relative">
      {/* Sidebar Overlay for Mobile */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <div className={cn(
        "fixed inset-y-0 left-0 z-50 w-72 border-r border-zinc-800 flex flex-col bg-zinc-900/50 backdrop-blur-xl transition-transform duration-300 lg:relative lg:translate-x-0",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 border-bottom border-zinc-800">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-orange-500 flex items-center justify-center shadow-lg shadow-orange-500/20">
                <MessageSquare className="text-white w-6 h-6" />
              </div>
              <div>
                <h1 className="font-bold text-lg tracking-tight">망고챗</h1>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <span className={cn("w-2 h-2 rounded-full", isP2P ? "bg-green-500" : "bg-blue-500")} />
                  {isP2P ? "P2P 연결됨" : "서버 연결됨"}
                </div>
              </div>
            </div>
            <button 
              onClick={() => setIsSidebarOpen(false)}
              className="lg:hidden p-2 hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              <div className="flex items-center gap-2">
                <Users size={14} />
                참여자 ({users.length})
              </div>
              {currentUser?.isHost && (
                <button 
                  onClick={toggleLock}
                  className="hover:text-orange-500 transition-colors"
                  title={roomLocked ? "방 잠금 해제" : "방 잠금"}
                >
                  {roomLocked ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
              )}
            </div>
            
            <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
              <AnimatePresence>
                {users.map((user) => (
                  <motion.div
                    key={user.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className={cn(
                      "group flex items-center justify-between p-3 rounded-xl transition-all",
                      user.id === currentUser?.id ? "bg-zinc-800/50 border border-zinc-700/50" : "hover:bg-zinc-800/30"
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center text-sm font-medium shrink-0">
                        {user.nickname[0]}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate flex items-center gap-1.5">
                          {user.nickname}
                          {user.isHost && <Shield size={12} className="text-orange-500" />}
                        </span>
                        {user.id === currentUser?.id && <span className="text-[10px] text-zinc-500">나</span>}
                      </div>
                    </div>
                    {currentUser?.isHost && user.id !== currentUser.id && (
                      <button
                        onClick={() => kickUser(user.id)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/10 hover:text-red-500 rounded-lg transition-all"
                      >
                        <UserX size={14} />
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="mt-auto p-6 border-t border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-orange-500/10 border border-orange-500/20 flex items-center justify-center text-orange-500 font-bold">
              {currentUser?.nickname[0]}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-semibold truncate">{currentUser?.nickname}</span>
              <span className="text-xs text-zinc-500">온라인</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div 
        className={cn(
          "flex-1 flex flex-col relative transition-colors duration-300 min-w-0",
          isDragging ? "bg-orange-500/5" : "bg-zinc-950"
        )}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Mobile Header */}
        <div className="lg:hidden flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-xl shrink-0">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <Menu size={20} />
            </button>
            <h1 className="font-bold text-sm tracking-tight">망고챗</h1>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className={cn("w-1.5 h-1.5 rounded-full", isP2P ? "bg-green-500" : "bg-blue-500")} />
            {isP2P ? "P2P" : "Server"}
          </div>
        </div>

        {/* Drop Overlay */}
        <AnimatePresence>
          {isDragging && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm border-4 border-dashed border-orange-500/50 m-4 rounded-3xl"
            >
              <div className="text-center">
                <div className="w-20 h-20 bg-orange-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-2xl shadow-orange-500/20">
                  <FileIcon className="text-white w-10 h-10" />
                </div>
                <p className="text-xl font-bold text-white">파일을 여기에 놓으세요</p>
                <p className="text-zinc-400 mt-2">상대방에게 즉시 전송됩니다</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-4">
              <div className="w-16 h-16 rounded-3xl bg-zinc-900 flex items-center justify-center">
                <MessageSquare size={32} />
              </div>
              <p className="text-sm">메시지를 보내 대화를 시작해보세요</p>
            </div>
          )}
          {messages.map((msg) => {
            if (msg.type === 'system') {
              return (
                <div key={msg.id} className="flex justify-center">
                  <span className="px-3 py-1 rounded-full bg-zinc-900 text-[10px] font-medium text-zinc-500 uppercase tracking-widest border border-zinc-800">
                    {msg.text}
                  </span>
                </div>
              );
            }

            const isOwn = msg.senderId === currentUser?.id;

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex flex-col max-w-[70%]",
                  isOwn ? "ml-auto items-end" : "items-start"
                )}
              >
                {!isOwn && (
                  <span className="text-xs font-medium text-zinc-500 mb-1.5 ml-1">
                    {msg.senderName}
                  </span>
                )}
                <div className={cn(
                  "p-4 rounded-2xl shadow-sm",
                  isOwn 
                    ? "bg-orange-500 text-white rounded-tr-none" 
                    : "bg-zinc-800 text-zinc-100 rounded-tl-none border border-zinc-700/50"
                )}>
                  {msg.type === 'text' ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {msg.text}
                    </p>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        "w-12 h-12 rounded-xl flex items-center justify-center shrink-0",
                        isOwn ? "bg-white/20" : "bg-zinc-700"
                      )}>
                        <FileIcon size={24} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">{msg.fileName}</span>
                        <a 
                          href={msg.fileData} 
                          download={msg.fileName}
                          className={cn(
                            "text-[10px] font-bold uppercase tracking-wider mt-1 flex items-center gap-1 hover:underline",
                            isOwn ? "text-white/80" : "text-orange-500"
                          )}
                        >
                          <Download size={10} />
                          다운로드
                        </a>
                      </div>
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-zinc-600 mt-1.5 px-1">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </motion.div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 md:p-8 pt-0">
          <form 
            onSubmit={handleSendMessage}
            className="relative flex items-center gap-2 md:gap-4 bg-zinc-900/50 border border-zinc-800 p-1.5 md:p-2 pl-4 md:pl-6 rounded-2xl focus-within:border-orange-500/50 transition-all"
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="메시지를 입력하세요..."
              className="flex-1 bg-transparent border-none outline-none text-sm py-3 placeholder:text-zinc-600 min-w-0"
            />
            <div className="flex items-center gap-1 md:gap-2 pr-1 md:pr-2 shrink-0">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 md:p-2.5 hover:bg-zinc-800 rounded-xl cursor-pointer text-zinc-400 transition-colors"
              >
                <FileIcon size={20} />
              </button>
              <input 
                ref={fileInputRef}
                type="file" 
                className="hidden" 
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    handleFileUpload(file);
                    // Reset value to allow selecting the same file again
                    e.target.value = '';
                  }
                }}
              />
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="p-2 md:p-2.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 disabled:hover:bg-orange-500 text-white rounded-xl transition-all shadow-lg shadow-orange-500/20"
              >
                <Send size={20} />
              </button>
            </div>
          </form>
          <p className="text-[10px] text-zinc-600 mt-3 text-center uppercase tracking-[0.2em]">
            {isP2P ? "P2P 암호화 통신 중" : "서버를 통한 보안 통신 중"}
          </p>
        </div>
      </div>

      {/* In-app Toast Notifications */}
      <div className="fixed top-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              className="w-80 bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 p-4 rounded-2xl shadow-2xl pointer-events-auto cursor-pointer"
              onClick={() => removeToast(toast.id)}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-orange-500/10 flex items-center justify-center shrink-0">
                  <MessageSquare size={20} className="text-orange-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-1">
                    {toast.message.senderName}
                  </p>
                  <p className="text-sm text-zinc-100 line-clamp-2">
                    {toast.message.type === 'text' ? toast.message.text : `파일을 보냈습니다: ${toast.message.fileName}`}
                  </p>
                </div>
                <button className="text-zinc-600 hover:text-zinc-400">
                  <X size={14} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}
