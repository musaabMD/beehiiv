// iCalendar (.ics) generation for event invites.
export interface IcsEvent {
  uid: string; title: string; description: string; start: number; end: number; location?: string; url?: string;
  organizer?: { name: string; email: string }; attendee?: { name: string; email: string }; method?: 'REQUEST' | 'PUBLISH'; sequence?: number;
}

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escText = (s: string) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold lines at 75 octets per RFC 5545. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function buildIcs(e: IcsEvent): string {
  const method = e.method || 'PUBLISH';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OpenHive//Events//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`,
    'BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`, `SEQUENCE:${e.sequence || 0}`,
    `SUMMARY:${escText(e.title)}`, `DESCRIPTION:${escText(e.description + (e.url ? `\n\nJoin: ${e.url}` : ''))}`,
    e.location ? `LOCATION:${escText(e.location)}` : '', e.url ? `URL:${e.url}` : '',
    e.organizer ? `ORGANIZER;CN=${escText(e.organizer.name)}:mailto:${e.organizer.email}` : '',
    e.attendee ? `ATTENDEE;CN=${escText(e.attendee.name || e.attendee.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${e.attendee.email}` : '',
    'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', `DESCRIPTION:${escText(e.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(e: { title: string; description: string; start: number; end: number; location?: string }): string {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${stamp(e.start)}/${stamp(e.end)}`, details: e.description.slice(0, 1500), location: e.location || '' });
  return `https://calendar.google.com/calendar/render?${p}`;
}

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
