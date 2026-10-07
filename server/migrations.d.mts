export function sortMigrationFiles(files: string[]): string[];
export function loadMigrations(directory?: string): Promise<Array<{ version: number; name: string; sql: string }>>;
export function runMigrations(pool: { connect(): Promise<{ query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>; release(): void }> }, options?: { directory?: string }): Promise<string[]>;
