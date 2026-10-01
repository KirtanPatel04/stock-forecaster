import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { layouts, useLayouts, type LayoutPage } from '../../lib/layouts';

export const COLS = 24;
export const ROWS = 40;          // the default layout fills the screen in 40 rows
const MARGIN = 6;

export interface WidgetDef {
  id: string;
  title: string;
  render: () => ReactNode;
  minW?: number;
  minH?: number;
}

interface Props {
  page: LayoutPage;
  widgets: WidgetDef[];
  defaultLayout: Layout[];
}

/**
 * A Webull-style page: every panel is a widget you can drag (by its title bar) and resize (from
 * its edges) while "Edit layout" is on, hide or bring back from the Widgets menu, and reset.
 * The layout is saved per page.
 */
export function WidgetGrid({ page, widgets, defaultLayout }: Props) {
  const { editing, pages } = useLayouts();
  const isEditing = editing === page;
  const saved = pages[page];
  const hidden = saved?.hidden ?? [];
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(800);
  const [width, setWidth] = useState(0);

  // Measure our own box (not the window): the page may be mounted hidden and shown later
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setHeight(el.clientHeight); setWidth(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rows scale with the window so the default layout always fits the screen
  const rowHeight = Math.max(8, (height - MARGIN * (ROWS + 1)) / ROWS);

  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  // Saved layout, minus widgets that no longer exist, plus any new (not hidden) widgets from the default
  const layout = useMemo<Layout[]>(() => {
    const base = (saved?.layout ?? defaultLayout).filter((l) => byId.has(l.i) && !hidden.includes(l.i));
    const missing = defaultLayout.filter((d) => byId.has(d.i) && !hidden.includes(d.i) && !base.some((l) => l.i === d.i));
    return [...base, ...missing].map((l) => {
      const w = byId.get(l.i)!;
      return { ...l, minW: w.minW ?? 3, minH: w.minH ?? 3 };
    });
  }, [saved, defaultLayout, byId, hidden]);

  const onLayoutChange = (next: Layout[]) => {
    if (!isEditing) return;
    layouts.save(page, { layout: next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })), hidden });
  };

  const hide = (id: string) => layouts.save(page, { layout: layout.filter((l) => l.i !== id), hidden: [...hidden, id] });
  const show = (id: string) => {
    const d = defaultLayout.find((l) => l.i === id) ?? { i: id, x: 0, y: 0, w: 6, h: 8 };
    // Bring it back at its default size, at the bottom; the grid compacts it into place
    layouts.save(page, { layout: [...layout, { ...d, y: ROWS }], hidden: hidden.filter((h) => h !== id) });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {isEditing && (
        <div className="flex items-center gap-2 flex-wrap px-3 py-1.5 bg-accent/10 border-b border-accent/40 text-[11px]">
          <span className="font-semibold text-accent">⊞ Editing layout</span>
          <span className="text-gray-400">Drag a panel by its blue title bar · resize from the right, bottom or corner</span>
          <span className="ml-2 text-gray-500">Widgets:</span>
          {widgets.map((w) => {
            const on = !hidden.includes(w.id);
            return (
              <button key={w.id} onClick={() => (on ? hide(w.id) : show(w.id))}
                className={`px-1.5 py-0.5 rounded border ${on ? 'border-accent/60 text-accent' : 'border-border text-gray-500 line-through'}`}
                title={on ? 'Hide' : 'Show'}>
                {w.title}
              </button>
            );
          })}
          <button onClick={() => window.confirm('Reset this page to the default layout?') && layouts.reset(page)}
            className="ml-auto px-2 py-0.5 rounded border border-border text-gray-300 hover:text-white">Reset layout</button>
          <button onClick={() => layouts.setEditing(null)} className="px-3 py-0.5 rounded bg-accent text-black font-semibold">Done</button>
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {width > 0 && <GridLayout
          width={width}
          layout={layout}
          cols={COLS}
          rowHeight={rowHeight}
          margin={[MARGIN, MARGIN]}
          containerPadding={[MARGIN, MARGIN]}
          isDraggable={isEditing}
          isResizable={isEditing}
          draggableHandle=".widget-drag"
          resizeHandles={['se', 'e', 's']}
          compactType="vertical"
          onLayoutChange={onLayoutChange}
        >
          {layout.map((l) => {
            const w = byId.get(l.i)!;
            return (
              <div key={l.i}
                className={`bg-panel rounded overflow-hidden flex flex-col border ${isEditing ? 'border-accent/60 border-dashed' : 'border-border'}`}>
                {isEditing && (
                  <div className="widget-drag cursor-move h-6 flex-shrink-0 flex items-center justify-between px-2 bg-accent/20 text-[10px] font-semibold text-accent select-none">
                    <span>⠿ {w.title}</span>
                    <button onMouseDown={(e) => e.stopPropagation()} onClick={() => hide(l.i)} title="Hide this panel"
                      className="text-accent/70 hover:text-white">×</button>
                  </div>
                )}
                <div className={`flex-1 min-h-0 overflow-auto ${isEditing ? 'pointer-events-none select-none opacity-80' : ''}`}>
                  {w.render()}
                </div>
              </div>
            );
          })}
        </GridLayout>}
      </div>
    </div>
  );
}
