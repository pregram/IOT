/**
 * Realtime sync facade over Firebase RTDB, path-based like RTDB itself:
 * subscribe(path, cb) -> unsubscribe, get, set, update (shallow merge), remove,
 * onSyncStatus(cb) ('connecting' | 'online' | 'error') and retry().
 *
 * There is no offline fallback driver: if Firebase cannot be reached, the app shows
 * the "Can't reach game services" screen with a Retry button (see SnapRiddleApp).
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  onValue,
  get as rtdbGet,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  type Database,
} from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyAQu8DTcyVSMylEFFcSQAYpMisoKWacSdY',
  authDomain: 'camgame-d52b0.firebaseapp.com',
  databaseURL: 'https://camgame-d52b0-default-rtdb.firebaseio.com',
  projectId: 'camgame-d52b0',
  storageBucket: 'camgame-d52b0.firebasestorage.app',
  messagingSenderId: '1048413048319',
  appId: '1:1048413048319:web:6083e7e32a54e27daaabca',
  measurementId: 'G-Z1BCLVMVGR',
};

const FIREBASE_CONNECT_TIMEOUT_MS = 3500;

export type SyncStatus = 'connecting' | 'online' | 'error';

type Listener = (value: unknown) => void;
type Unsubscribe = () => void;

interface Sub {
  path: string;
  cb: Listener;
  unsub: Unsubscribe;
}

class SyncFacade {
  private app: FirebaseApp | null = null;
  private db: Database | null = null;
  private subs = new Map<number, Sub>();
  private subSeq = 0;
  private status: SyncStatus = 'connecting';
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private started = false;
  private probing = false;

  getSyncStatus(): SyncStatus {
    return this.status;
  }

  onSyncStatus(cb: (s: SyncStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    void this.connect();
  }

  /** Re-run the connection probe (the error screen's Retry button). */
  retry() {
    if (typeof window === 'undefined') return;
    this.setStatus('connecting');
    void this.connect();
  }

  private async connect() {
    if (this.probing) return;
    this.probing = true;
    try {
      if (!this.app) {
        this.app = initializeApp(firebaseConfig);
        this.db = getDatabase(this.app);
      }
      const db = this.db;
      if (!db) throw new Error('no database');
      const connected = await Promise.race<boolean>([
        new Promise<boolean>((resolve) => {
          const unsub = onValue(
            ref(db, '.info/connected'),
            (snap) => {
              if (snap.val() === true) {
                unsub();
                resolve(true);
              }
            },
            () => {
              unsub();
              resolve(false);
            },
          );
        }),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), FIREBASE_CONNECT_TIMEOUT_MS),
        ),
      ]);
      if (connected) {
        // (Re-)bind every active subscription onto the live database.
        for (const sub of this.subs.values()) {
          try {
            sub.unsub();
          } catch {
            /* already gone */
          }
          const r = ref(db, sub.path);
          sub.unsub = onValue(r, (snap) => sub.cb(snap.val()), () => sub.cb(null));
        }
        this.setStatus('online');
      } else {
        this.setStatus('error');
      }
    } catch {
      this.setStatus('error');
    } finally {
      this.probing = false;
    }
  }

  subscribe(path: string, cb: Listener): Unsubscribe {
    const id = ++this.subSeq;
    let unsub: Unsubscribe = () => undefined;
    if (this.db && this.status === 'online') {
      const r = ref(this.db, path);
      const real = onValue(r, (snap) => cb(snap.val()), () => cb(null));
      unsub = real;
    }
    const sub: Sub = { path, cb, unsub };
    this.subs.set(id, sub);
    return () => {
      try {
        sub.unsub();
      } catch {
        /* already gone */
      }
      this.subs.delete(id);
    };
  }

  async get(path: string): Promise<unknown> {
    if (!this.db) return null;
    const snap = await rtdbGet(ref(this.db, path));
    return snap.val();
  }

  async set(path: string, value: unknown): Promise<void> {
    if (!this.db) return;
    await rtdbSet(ref(this.db, path), value);
  }

  async update(path: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.db) return;
    await rtdbUpdate(ref(this.db, path), patch);
  }

  async remove(path: string): Promise<void> {
    if (!this.db) return;
    await rtdbRemove(ref(this.db, path));
  }
}

export const sync = new SyncFacade();
export type { Unsubscribe };
