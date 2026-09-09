import { SupportTicket, AuditLog } from '../types';
import { 
  getTelegramNotifications, 
  sendTelegramNotification,
  logAuditAction,
  claimTicket,
  assignTicket,
  resolveTicket,
  TelegramNotificationRecord
} from './api';

export {
  getTelegramNotifications,
  sendTelegramNotification,
  logAuditAction,
  claimTicket,
  assignTicket,
  resolveTicket
};
export type { TelegramNotificationRecord };
