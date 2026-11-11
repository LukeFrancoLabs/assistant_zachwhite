'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_COOLDOWN_HOURS = 48;
const DEFAULT_RESERVATION_MINUTES = 30;
const DEFAULT_RETENTION_HOURS = 48;

function normalizeContactId(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeTemplateName(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function createTemplateKey(channel, templateName, content = '') {
  const normalizedName = normalizeTemplateName(templateName || 'custom');
  const contentHash = crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 16);
  return `${channel}:${normalizedName}:${contentHash}`;
}

function formatAge(isoDate, now = Date.now()) {
  if (!isoDate) return 'never';
  const elapsedMs = Math.max(0, now - new Date(isoDate).getTime());
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = elapsedMs / 3600000;
  if (hours < 48) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.floor(days)}d ago`;
}

class ContactHistory {
  constructor(options = {}) {
    this.historyFile = options.historyFile || path.join(__dirname, 'contact-history.jsonl');
    this.lockFile = options.lockFile || path.join(__dirname, 'contact-history.lock');
    this.cooldownHours = options.cooldownHours || DEFAULT_COOLDOWN_HOURS;
    this.reservationMinutes = options.reservationMinutes || DEFAULT_RESERVATION_MINUTES;
    this.retentionHours = options.retentionHours || DEFAULT_RETENTION_HOURS;
    this.offset = 0;
    this.remainder = '';
    this.deliveries = new Map();
    this.reservations = new Map();
    this.activeReservationsByContact = new Map();
    this.aliasToContact = new Map();
    this._ensureStorage();
    this._refresh();
    this._withLock(() => this._compactLocked());
  }

  _ensureStorage() {
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    if (!fs.existsSync(this.historyFile)) fs.closeSync(fs.openSync(this.historyFile, 'a'));
  }

  _resetIndex() {
    this.offset = 0;
    this.remainder = '';
    this.deliveries.clear();
    this.reservations.clear();
    this.activeReservationsByContact.clear();
    this.aliasToContact.clear();
  }

  _refresh() {
    this._ensureStorage();
    let fileSize = fs.statSync(this.historyFile).size;
    if (fileSize < this.offset) {
      this._resetIndex();
      fileSize = fs.statSync(this.historyFile).size;
    }
    if (fileSize === this.offset) return;

    const length = fileSize - this.offset;
    const data = Buffer.allocUnsafe(length);
    const handle = fs.openSync(this.historyFile, 'r');
    try {
      fs.readSync(handle, data, 0, length, this.offset);
    } finally {
      fs.closeSync(handle);
    }
    this.offset = fileSize;
    const chunk = data.toString('utf8');
    const lines = (this.remainder + chunk).split('\n');
    this.remainder = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this._ingest(JSON.parse(line));
      } catch (error) {
        throw new Error(`Contact history contains invalid JSON: ${error.message}`);
      }
    }
  }

  _ingest(event) {
    if (!event || event.version !== 1) return;
    if (event.contactKey) {
      this.aliasToContact.set(normalizeContactId(event.contactKey), event.contactKey);
      for (const alias of event.aliases || []) {
        this.aliasToContact.set(normalizeContactId(alias), event.contactKey);
      }
    }
    if (event.type === 'delivery') {
      const list = this.deliveries.get(event.contactKey) || [];
      list.push(event);
      this.deliveries.set(event.contactKey, list);
    }
    if (event.reservationId) {
      const previous = this.reservations.get(event.reservationId);
      this.reservations.set(event.reservationId, event);
      if (event.type === 'reservation') {
        this.activeReservationsByContact.set(event.contactKey, event);
      } else {
        const contactKey = event.contactKey || previous?.contactKey;
        const active = contactKey ? this.activeReservationsByContact.get(contactKey) : null;
        if (active?.reservationId === event.reservationId) {
          this.activeReservationsByContact.delete(contactKey);
        }
      }
    }
  }

  _wait(ms) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, ms);
  }

  _withLock(callback) {
    const deadline = Date.now() + 5000;
    let lockHandle = null;

    while (!lockHandle) {
      try {
        lockHandle = fs.openSync(this.lockFile, 'wx');
        fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const ageMs = Date.now() - fs.statSync(this.lockFile).mtimeMs;
          if (ageMs > 5 * 60 * 1000) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch (_) {}
        if (Date.now() >= deadline) throw new Error('Contact history is busy; could not acquire its lock');
        this._wait(50);
      }
    }

    try {
      this._refresh();
      return callback();
    } finally {
      try { fs.closeSync(lockHandle); } catch (_) {}
      try { fs.unlinkSync(this.lockFile); } catch (_) {}
    }
  }

  _appendLocked(event) {
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(this.historyFile, line, 'utf8');
    this.offset += Buffer.byteLength(line);
    this._ingest(event);
  }

  _compactLocked() {
    const now = Date.now();
    const cutoff = now - this.retentionHours * 3600000;
    const retainedDeliveries = [];
    for (const events of this.deliveries.values()) {
      for (const event of events) {
        if (new Date(event.sentAt).getTime() >= cutoff) retainedDeliveries.push(event);
      }
    }
    const activeReservations = [...this.activeReservationsByContact.values()].filter(
      (event) => new Date(event.expiresAt).getTime() > now
    );
    const retainedEvents = [...retainedDeliveries, ...activeReservations]
      .sort((a, b) => new Date(a.sentAt || a.createdAt) - new Date(b.sentAt || b.createdAt));

    const temporaryFile = `${this.historyFile}.${process.pid}.tmp`;
    const contents = retainedEvents.length
      ? retainedEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'
      : '';
    fs.writeFileSync(temporaryFile, contents, 'utf8');
    fs.renameSync(temporaryFile, this.historyFile);
    this._resetIndex();
    this._refresh();
  }

  _latest(events) {
    if (!events.length) return null;
    return events.reduce((latest, event) => {
      if (!latest) return event;
      return new Date(event.sentAt).getTime() > new Date(latest.sentAt).getTime() ? event : latest;
    }, null);
  }

  _evaluate({ contactId, channel, templateKey, cooldownHours, aliases = [] }) {
    const requestedContactKey = normalizeContactId(contactId);
    if (!requestedContactKey) throw new Error('Cannot check contact history without a contact identifier');

    const requestedAliases = [...new Set(aliases.map(normalizeContactId).filter(Boolean))];
    const requestedKeys = [requestedContactKey, ...requestedAliases];
    const mappedKeys = requestedKeys.map((key) => this.aliasToContact.get(key)).filter(Boolean);
    const contactKey = mappedKeys[0] || requestedContactKey;
    const relatedKeys = [...new Set([contactKey, requestedContactKey, ...mappedKeys])];
    const retentionCutoff = Date.now() - this.retentionHours * 3600000;
    const deliveries = relatedKeys
      .flatMap((key) => this.deliveries.get(key) || [])
      .filter((event) => new Date(event.sentAt).getTime() >= retentionCutoff);
    const lastContact = this._latest(deliveries);
    const lastEmail = this._latest(deliveries.filter((event) => event.channel === 'email'));
    const lastText = this._latest(deliveries.filter((event) => event.channel === 'text'));
    const sameTemplate = this._latest(deliveries.filter(
      (event) => event.channel === channel && event.templateKey === templateKey
    ));

    const now = Date.now();
    // Use == null (not ||) so an explicit cooldownHours: 0 is honored — this lets a
    // paired follow-up (e.g. Assistant2 emailing a pro right after texting them)
    // bypass the recent-contact cooldown while same-template and active-reservation
    // protections still apply. Omitting cooldownHours keeps the default (48h).
    const effectiveCooldownHours = cooldownHours == null ? this.cooldownHours : cooldownHours;
    const cooldownMs = effectiveCooldownHours * 3600000;
    const recentContact = lastContact && now - new Date(lastContact.sentAt).getTime() < cooldownMs
      ? lastContact
      : null;

    const reservationForContact = relatedKeys
      .map((key) => this.activeReservationsByContact.get(key))
      .find(Boolean) || null;
    const activeReservation = reservationForContact && new Date(reservationForContact.expiresAt).getTime() > now
      ? reservationForContact
      : null;
    if (reservationForContact && !activeReservation) this.activeReservationsByContact.delete(contactKey);

    const reasons = [];
    if (activeReservation) reasons.push({ code: 'active_reservation', event: activeReservation });
    if (recentContact) reasons.push({ code: 'recent_contact', event: recentContact });
    if (sameTemplate) reasons.push({ code: 'same_template', event: sameTemplate });

    return {
      allowed: reasons.length === 0,
      contactKey,
      lastContact,
      lastEmail,
      lastText,
      sameTemplate,
      activeReservation,
      reasons,
      cooldownHours: effectiveCooldownHours,
      aliases: requestedAliases,
    };
  }

  check(request) {
    return this._withLock(() => this._evaluate(request));
  }

  reserve(request) {
    return this._withLock(() => {
      const decision = this._evaluate(request);
      if (!decision.allowed) return decision;

      const now = new Date();
      const reservation = {
        version: 1,
        type: 'reservation',
        eventId: crypto.randomUUID(),
        reservationId: crypto.randomUUID(),
        contactKey: decision.contactKey,
        contactLabel: String(request.contactLabel || request.contactId),
        aliases: decision.aliases,
        channel: request.channel,
        templateKey: request.templateKey,
        templateName: request.templateName,
        content: request.content || null,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.reservationMinutes * 60000).toISOString(),
        source: request.source,
      };
      this._appendLocked(reservation);
      return { ...decision, reservationId: reservation.reservationId, reservation };
    });
  }

  recordDelivery(reservationId) {
    return this._withLock(() => {
      const reservation = this.reservations.get(reservationId);
      if (!reservation || reservation.type !== 'reservation') {
        throw new Error(`Unknown or closed contact-history reservation: ${reservationId}`);
      }
      const delivery = {
        ...reservation,
        type: 'delivery',
        eventId: crypto.randomUUID(),
        sentAt: new Date().toISOString(),
      };
      delete delivery.expiresAt;
      this._appendLocked(delivery);
      return delivery;
    });
  }

  cancelReservation(reservationId, reason = 'send failed') {
    if (!reservationId) return null;
    return this._withLock(() => {
      const reservation = this.reservations.get(reservationId);
      if (!reservation || reservation.type !== 'reservation') return null;
      const cancelled = {
        version: 1,
        type: 'cancelled',
        eventId: crypto.randomUUID(),
        reservationId,
        contactKey: reservation.contactKey,
        channel: reservation.channel,
        cancelledAt: new Date().toISOString(),
        reason,
      };
      this._appendLocked(cancelled);
      return cancelled;
    });
  }

  getHistory(contactId) {
    return this._withLock(() => {
      const contactKey = normalizeContactId(contactId);
      const cutoff = Date.now() - this.retentionHours * 3600000;
      return [...(this.deliveries.get(contactKey) || [])]
        .filter((event) => new Date(event.sentAt).getTime() >= cutoff)
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
    });
  }

  findHistory(query) {
    return this._withLock(() => {
      const normalizedQuery = normalizeContactId(query);
      const cutoff = Date.now() - this.retentionHours * 3600000;
      const direct = this.deliveries.get(normalizedQuery);
      if (direct?.length) {
        return [...direct]
          .filter((event) => new Date(event.sentAt).getTime() >= cutoff)
          .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
      }

      const matches = [];
      for (const events of this.deliveries.values()) {
        for (const event of events) {
          if (
            new Date(event.sentAt).getTime() >= cutoff &&
            normalizeContactId(event.contactLabel) === normalizedQuery
          ) matches.push(event);
        }
      }
      return matches.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    });
  }

  getStats() {
    return this._withLock(() => {
      const cutoff = Date.now() - this.retentionHours * 3600000;
      let deliveries = 0;
      const byChannel = { email: 0, text: 0 };
      let latestDelivery = null;
      for (const events of this.deliveries.values()) {
        deliveries += events.length;
        for (const event of events) {
          if (new Date(event.sentAt).getTime() < cutoff) continue;
          deliveries++;
          if (event.channel in byChannel) byChannel[event.channel]++;
          if (!latestDelivery || new Date(event.sentAt) > new Date(latestDelivery.sentAt)) latestDelivery = event;
        }
      }
      const contacts = [...this.deliveries.values()].filter((events) =>
        events.some((event) => new Date(event.sentAt).getTime() >= cutoff)
      ).length;
      return { contacts, deliveries, byChannel, latestDelivery };
    });
  }
}

module.exports = {
  ContactHistory,
  createTemplateKey,
  formatAge,
  normalizeContactId,
  DEFAULT_COOLDOWN_HOURS,
};
