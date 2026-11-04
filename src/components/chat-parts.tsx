import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, CheckCheck, Clock3, FileText, ImageIcon, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { Attachment, ConnectionStatus, MessageDelivery, Presence, Provider } from '@/model/types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export const providerName = (provider: Provider) => provider === 'skype' ? 'Skype for Business' : 'Teamwire';

export function ProviderIcon({ provider, className = '' }: { provider: Provider; className?: string }) {
  return <span className={cn('provider-icon', `provider-${provider}`, className)} aria-hidden="true">{provider === 'skype' ? 'S' : <svg viewBox="0 0 20 20" fill="none"><path d="M4 5h12M7 9h6M10 5v11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>}</span>;
}

export function Avatar({ initials, color = 'violet', presence, group = false, className = '' }: {
  initials: string; color?: string; presence?: Presence; group?: boolean; className?: string;
}) {
  const palette = ['violet', 'purple', 'blue', 'teal', 'green', 'sage', 'amber', 'orange', 'rose', 'pink', 'slate', 'peach', 'mint', 'lavender'];
  const semantic = palette.find((name) => color.toLowerCase().includes(name));
  const isCssColor = /^#[\da-f]{3,8}$/i.test(color) || /^(?:rgb|hsl|oklch)\(/.test(color);
  return <span className={cn('person-avatar', `avatar-${semantic ?? 'violet'}`, group && 'group-avatar', className)} style={isCssColor ? { background: color } : undefined} aria-hidden="true">
    <span>{initials}</span>{presence && presence !== 'unknown' && <span className={`presence-dot presence-${presence}`} />}
  </span>;
}

export function IconButton({ label, children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} className={cn('icon-button', className)} {...props}>{children}</Button>;
}

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  return status === 'connecting' ? <LoaderCircle className="connection-spinner" aria-hidden="true" /> : <span className={`connection-dot connection-${status}`} aria-hidden="true" />;
}

export function Delivery({ status, error, demo }: { status: MessageDelivery; error?: string; demo?: boolean }) {
  if (demo) return <span className="message-delivery demo-delivery">Demo message</span>;
  const label = { pending: 'Sending', accepted: 'Accepted by server', delivered: 'Delivered', read: 'Read', failed: 'Failed to send' }[status];
  const Icon = status === 'pending' ? Clock3 : status === 'failed' ? TriangleAlert : status === 'accepted' ? Check : CheckCheck;
  return <span className={cn('message-delivery', `delivery-${status}`)} title={error || label} aria-label={label}><Icon aria-hidden="true" /><span>{label}</span></span>;
}

export function AttachmentTile({ attachment, compact = false }: { attachment: Attachment; compact?: boolean }) {
  return <div className={cn('attachment-tile', compact && 'attachment-compact')} aria-label={`Attachment: ${attachment.name}${attachment.size ? `, ${attachment.size}` : ''}`}>
    <span className={cn('attachment-icon', attachment.kind === 'image' && 'attachment-image')}>{attachment.kind === 'image' ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}</span>
    <span className="attachment-description"><strong>{attachment.name}</strong><span>{attachment.size || (attachment.kind === 'image' ? 'Image' : 'Document')}</span></span>
  </div>;
}

export function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function inboxDateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return timeLabel(value);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

export function dayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Conversation';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

export function initialsFor(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
