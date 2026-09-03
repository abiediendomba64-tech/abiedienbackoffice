export type NavTab = 'dashboard' | 'users' | 'analytics' | 'logs' | 'tickets' | 'settings';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'Super Admin' | 'Admin' | 'Manager' | 'Support' | 'User';
  status: 'active' | 'inactive' | 'suspended';
  avatar: string;
  lastLogin: string;
  department: string;
  projectsCount: number;
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
  subject: string;
  user: string;
  email: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  createdAt: string;
  category: string;
}

export interface SystemMetric {
  title: string;
  value: string;
  change: string;
  isPositive: boolean;
  timeframe: string;
}
