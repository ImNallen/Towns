/** Versioned binary save layout. Each owner visits its persistent fields in the same
 * order for capture and restore. Derived geometry, routing scratch and frame data
 * are rebuilt by constructors. No snapshot work runs inside World.step(). */
export interface SnapshotIO {
  readonly mode: 'read' | 'write' | 'measure';
  arrays(...fields: ArrayBufferView[]): void;
  table(rows: readonly ArrayBufferView[]): void;
  number(value: number): number;
  strings(values: string[]): void;
}
