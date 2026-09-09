export type NavTab = 'dashboard' | 'users' | 'analytics' | 'logs' | 'tickets' | 'settings';

export interface User {
  id: string;
  telegram_id?: string;
  username?: string;
  full_name: string;
  email?: string;
  role: 'new_user' | 'member' | 'admin' | 'dev' | 'super_admin' | 'root';
  status: 'active' | 'suspended' | 'banned';
  domain_name?: string;
  domain_verified: boolean;
  onboarding_status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'QUARANTINED';
  risk_status: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  created_at?: string;
  updated_at?: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  target: string;
  severity: 'info' | 'warn' | 'error';
  ipAddress: string;
}

export interface SupportTicket {
  id: string;
  ticket_number: string;
  user_id: string;
  assigned_to?: string;
  category: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  status: 'draft' | 'pending' | 'assigned' | 'waiting_member' | 'in_progress' | 'escalated' | 'resolved' | 'closed' | 'rejected' | 'cancelled';
  title?: string;
  description: string;
  collected_data: Record<string, any>;
  resolution_notes?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SystemMetric {
  title: string;
  value: string;
  change: string;
  isPositive: boolean;
  timeframe: string;
}

export interface LoginDetectionRecord {
  id: string;
  telegramId: string;
  name: string;
  username: string;
  role: 'super_admin' | 'member' | 'guest';
  status: 'authorized' | 'denied' | 'pending';
  timestamp: string;
  platform: 'telegram_mobile' | 'telegram_desktop' | 'web_browser';
  authMethod: string;
  ipHint?: string;
}
