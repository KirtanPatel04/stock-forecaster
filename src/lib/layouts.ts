/**
 * Customisable page layouts (Webull-style): which widgets are shown, where, and how big.
 * Saved per page in localStorage; `editing` (layout mode on/off) is session-only.
 */
import { useSyncExternalStore } from 'react';
import type { Layout } from 'react-grid-layout';

export type LayoutPage = 'daytrade' | 'watchlist';

export interface PageLayout {
  layout: Layout[];
  hidden: string[];
}

interface State {
  editing: LayoutPage | null;
  pages: Partial<Record<LayoutPage, PageLayout>>;
}

const KEY = 'sf_layouts';

function load(): State {
  try {
    return { editing: null, pages: JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { editing: null, pages: {} };
  }
}

let state: State = load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state.pages)); } catch { /* ignore */ } };

export const layouts = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  setEditing(page: LayoutPage | null) { state = { ...state, editing: page }; emit(); },
  save(page: LayoutPage, next: PageLayout) {
    state = { ...state, pages: { ...state.pages, [page]: next } };
    persist();
    emit();
  },
  reset(page: LayoutPage) {
    const pages = { ...state.pages };
    delete pages[page];
    state = { ...state, pages };
    persist();
    emit();
  },
};

export function useLayouts(): State {
  return useSyncExternalStore(layouts.subscribe, layouts.get);
}
