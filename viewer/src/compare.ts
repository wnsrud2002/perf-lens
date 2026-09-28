// 전후 비교: 지금 열린 결과를 기준(전)으로 고정해 두고, 새로 연 결과(후)와 함수별로 비교한다.
// 트레이스 두 개를 나란히 띄우는 대신 표로 본다. 고친 효과를 확인하는 데는 이 정도로 충분하다
import type { FnStat } from './analyze.ts';
import type { FnAlloc } from './link.ts';

export interface Snapshot {
  label: string;
  duration: number; // µs, 트레이스 전체 길이
  stats: FnStat[];
  allocs: FnAlloc[]; // 두 로그가 연결돼 있을 때만 있다
  leaks: number; // heap.bin 전체의 누수 후보 (없으면 NaN)
  leakBytes: number;
}

export interface DiffRow {
  name: string;
  before?: FnStat;
  after?: FnStat;
  allocBefore?: FnAlloc;
  allocAfter?: FnAlloc;
}

// 두 결과에 나온 함수를 합쳐, total 시간 변화가 큰 순서로
export function diff(a: Snapshot, b: Snapshot): DiffRow[] {
  const rows = new Map<string, DiffRow>();
  const row = (name: string) => rows.get(name) ?? rows.set(name, { name }).get(name)!;
  for (const s of a.stats) row(s.name).before = s;
  for (const s of b.stats) row(s.name).after = s;
  for (const s of a.allocs) row(s.name).allocBefore = s;
  for (const s of b.allocs) row(s.name).allocAfter = s;
  const delta = (r: DiffRow) => Math.abs((r.after?.total ?? 0) - (r.before?.total ?? 0));
  return [...rows.values()].sort((x, y) => delta(y) - delta(x));
}
