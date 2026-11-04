import { getLink, hasLink, type ResourceReference, type UcwaResource } from 'skypeforhoo';
import type { MessageDelivery, Presence } from '../model/types';

export function ucwaDate(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value !== 'string') return fallback;
  const legacy = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(value);
  const date = new Date(legacy ? Number(legacy[1]) : value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function ucwaPresence(value: unknown): Presence {
  if (typeof value !== 'string') return 'unknown';
  const availability = value.toLowerCase();
  if (availability === 'online') return 'online';
  if (['busy', 'donotdisturb'].includes(availability)) return 'busy';
  if (['away', 'berightback', 'idle'].includes(availability)) return 'away';
  return ['offline', 'offwork'].includes(availability) ? 'offline' : 'unknown';
}

export function ucwaDelivery(value: unknown): MessageDelivery {
  if (value === 'Succeeded') return 'delivered';
  if (value === 'Failed') return 'failed';
  return 'accepted';
}

/** Inert text only; message HTML is never mounted into the React document. */
export function plainText(value: string, html = false): string {
  if (!html) return value;
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(value, 'text/html');
    document.querySelectorAll('script,style,template,noscript').forEach((element) => element.remove());
    document.querySelectorAll('br').forEach((element) => element.replaceWith('\n'));
    document.querySelectorAll('p,div,li').forEach((element) => element.append('\n'));
    return (document.body.textContent ?? '').trim();
  }
  return value.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

export function inlineMessage(uri: string): { text: string; html: boolean } {
  const match = /^data:(text\/(?:plain|html))(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!match) throw new Error('Unsupported inline message representation.');
  const encoded = decodeURIComponent(match[3]!);
  const text = match[2] ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))) : encoded;
  return { text: plainText(text, match[1]!.toLowerCase() === 'text/html'), html: match[1]!.toLowerCase() === 'text/html' };
}

export function embeddedCollection(reference: ResourceReference, relation: string): ResourceReference[] {
  const embedded = reference.data._embedded?.[relation];
  if (embedded === undefined) return [];
  const entries = Array.isArray(embedded) ? embedded : [embedded];
  return entries.filter((entry): entry is UcwaResource => typeof entry === 'object' && entry !== null && !Array.isArray(entry)).map((data) => ({
    data, url: hasLink(data, 'self') ? getLink(data, 'self', reference.url) : reference.url,
  }));
}
