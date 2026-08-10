// Hosts the Socket.io server dashboard browser tabs connect to - the
// "outbound" half of the old monolith's socket.ts. Every other service just
// publishes a domain event; this is the one place that turns those into a
// live push to the right user's room (+ admins), same as emitToOwner() did.
import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'sendago-super-secret-jwt-key';
let io: SocketServer | null = null;

export const initDashboardSocket = (server: HTTPServer) => {
  io = new SocketServer(server, { cors: { origin: process.env.CORS_ORIGIN || 'http://localhost:5173', methods: ['GET', 'POST'] } });

  io.on('connection', (socket: Socket) => {
    const token = socket.handshake.auth?.token;
    let decoded: { id: string; email: string; role: string };
    try {
      decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string; role: string };
    } catch {
      console.warn(`[notification] Rejected dashboard connection with invalid/missing token: ${socket.id}`);
      socket.disconnect();
      return;
    }

    console.log(`[notification] Dashboard client connected: ${socket.id} (user ${decoded.id})`);
    socket.join(`user:${decoded.id}`);
    if (decoded.role === 'admin') socket.join('admin');

    socket.on('disconnect', () => console.log(`[notification] Dashboard client disconnected: ${socket.id}`));
  });

  return io;
};

export const emitToOwner = (userId: string, event: string, payload: any) => {
  io?.to(`user:${userId}`).to('admin').emit(event, payload);
};
