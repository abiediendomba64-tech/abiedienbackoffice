import { supabase, isSupabaseConfigured } from './supabase';
import { SupportTicket, AuditLog } from '../types';

export interface TelegramNotificationRecord {
  id: string;
  timestamp: string;
  recipient: string;
  message: string;
  status: 'Pending' | 'Sent' | 'Failed';
  error?: string;
}

let localNotifications: TelegramNotificationRecord[] = [
  {
    id: 'NOTIF-101',
    timestamp: '2026-09-03 10:45:12',
    recipient: '@AbiedOpsBot (Admin Group)',
    message: 'High priority incident TICK-401 assigned to Amina Diallo.',
    status: 'Sent'
  },
  {
    id: 'NOTIF-102',
    timestamp: '2026-09-03 10:50:30',
    recipient: '@AbiedSecurityAlerts',
    message: 'Warning: Multiple failed authentication attempts detected from IP 192.168.1.88.',
    status: 'Pending'
  },
  {
    id: 'NOTIF-103',
    timestamp: '2026-09-03 09:12:00',
    recipient: '@AbiedClusterDeploy',
    message: 'Production deployment cluster us-central1 completed successfully.',
    status: 'Failed',
    error: 'Telegram API timeout (504 Gateway Timeout)'
  }
];

export const getTelegramNotifications = async (): Promise<TelegramNotificationRecord[]> => {
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase.from('telegram_notifications').select('*').order('timestamp', { ascending: false });
      if (!error && data && data.length > 0) {
        return data as TelegramNotificationRecord[];
      }
    } catch (e) {
      console.warn('Supabase telegram_notifications fetch failed, using local state:', e);
    }
  }
  return localNotifications;
};

export const sendTelegramNotification = async (recipient: string, message: string): Promise<TelegramNotificationRecord> => {
  const newNotif: TelegramNotificationRecord = {
    id: `NOTIF-${Math.floor(100 + Math.random() * 900)}`,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    recipient,
    message,
    status: 'Pending'
  };

  localNotifications = [newNotif, ...localNotifications];

  if (isSupabaseConfigured) {
    try {
      await supabase.from('telegram_notifications').insert([newNotif]);
    } catch (e) {
      console.warn('Supabase insert notification error:', e);
    }
  }

  // Simulate delivery tracking update
  setTimeout(async () => {
    const success = Math.random() > 0.15; // 85% success rate
    newNotif.status = success ? 'Sent' : 'Failed';
    if (!success) {
      newNotif.error = 'Telegram Bot API timeout or network unreachable';
    }
    if (isSupabaseConfigured) {
      try {
        await supabase.from('telegram_notifications').update({ status: newNotif.status, error: newNotif.error }).eq('id', newNotif.id);
      } catch (e) {
        // ignore
      }
    }
  }, 2500);

  return newNotif;
};

export const logAuditAction = async (action: string, target: string, severity: 'info' | 'warn' | 'error', user: string = 'Abied Iendomba'): Promise<AuditLog> => {
  const newLog: AuditLog = {
    id: `LOG-${Math.floor(1000 + Math.random() * 9000)}`,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    user,
    action,
    target,
    severity,
    ipAddress: '192.168.1.45'
  };

  if (isSupabaseConfigured) {
    try {
      await supabase.from('audit_logs').insert([newLog]);
    } catch (e) {
      console.warn('Failed to insert audit log to Supabase:', e);
    }
  }
  return newLog;
};

export const claimTicket = async (ticketId: string, operatorName: string): Promise<void> => {
  await logAuditAction('CLAIM_SUPPORT_TICKET', `Ticket #${ticketId} claimed by ${operatorName}`, 'info', operatorName);
  await sendTelegramNotification('@AbiedOpsBot', `Support Ticket ${ticketId} has been claimed by ${operatorName}.`);
  if (isSupabaseConfigured) {
    try {
      await supabase.from('support_tickets').update({ status: 'in_progress', user: operatorName }).eq('id', ticketId);
    } catch (e) {
      console.warn('Supabase ticket claim update error:', e);
    }
  }
};

export const assignTicket = async (ticketId: string, assigneeName: string, operatorName: string): Promise<void> => {
  await logAuditAction('ASSIGN_SUPPORT_TICKET', `Ticket #${ticketId} assigned to ${assigneeName} by ${operatorName}`, 'warn', operatorName);
  await sendTelegramNotification('@AbiedOpsBot', `Support Ticket ${ticketId} assigned to ${assigneeName} by ${operatorName}.`);
  if (isSupabaseConfigured) {
    try {
      await supabase.from('support_tickets').update({ status: 'in_progress', user: assigneeName }).eq('id', ticketId);
    } catch (e) {
      console.warn('Supabase ticket assign update error:', e);
    }
  }
};

export const resolveTicket = async (ticketId: string, resolutionNotes: string, operatorName: string): Promise<void> => {
  await logAuditAction('RESOLVE_SUPPORT_TICKET', `Ticket #${ticketId} resolved: "${resolutionNotes}"`, 'info', operatorName);
  await sendTelegramNotification('@AbiedOpsBot', `Support Ticket ${ticketId} successfully resolved by ${operatorName}.`);
  if (isSupabaseConfigured) {
    try {
      await supabase.from('support_tickets').update({ status: 'resolved' }).eq('id', ticketId);
    } catch (e) {
      console.warn('Supabase ticket resolve update error:', e);
    }
  }
};
