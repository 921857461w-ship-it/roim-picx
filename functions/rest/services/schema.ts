/**
 * D1 表结构自愈服务
 * Cloudflare Pages 部署不会自动执行 wrangler migrations，
 * 当数据库缺少后加迁移的表/列（如 albums.enable_random_image）时，
 * 相关接口会直接报 "no such table / no such column"。
 * 本服务在接口首次失败时按需补齐表结构并重试，实现零手动迁移。
 */

import type { D1Database } from '@cloudflare/workers-types'

// 每个 isolate 只检查一次，避免每次请求重复查询 pragma
let albumSchemaChecked = false

const ALBUM_TABLES: Record<string, string> = {
    albums: `CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        cover_image TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    album_images: `CREATE TABLE IF NOT EXISTS album_images (
        album_id INTEGER NOT NULL,
        image_key TEXT NOT NULL,
        image_url TEXT,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (album_id, image_key),
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    )`,
    album_shares: `CREATE TABLE IF NOT EXISTS album_shares (
        id TEXT PRIMARY KEY,
        album_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_login TEXT NOT NULL,
        password_hash TEXT,
        max_views INTEGER,
        current_views INTEGER DEFAULT 0,
        expires_at TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    )`
}

/** 后加迁移补充的列：表名 -> [列名, ALTER 语句] */
const EXTRA_COLUMNS: Record<string, Array<{ column: string, alter: string }>> = {
    albums: [
        {
            column: 'enable_random_image',
            alter: 'ALTER TABLE albums ADD COLUMN enable_random_image INTEGER DEFAULT 0'
        }
    ]
}

async function getTableColumns(db: D1Database, table: string): Promise<Set<string>> {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    return new Set((rows.results || []).map(r => r.name))
}

/**
 * 确保相册相关的表与列存在（幂等）。
 * @param force 强制执行（跳过 isolate 级缓存），用于失败后自愈重试
 */
export async function ensureAlbumSchema(db: D1Database, force = false): Promise<void> {
    if (albumSchemaChecked && !force) return

    // 1. 建表（IF NOT EXISTS 幂等）
    for (const ddl of Object.values(ALBUM_TABLES)) {
        await db.prepare(ddl).run()
    }

    // 2. 补齐后加迁移的列
    for (const [table, columns] of Object.entries(EXTRA_COLUMNS)) {
        const existing = await getTableColumns(db, table)
        for (const { column, alter } of columns) {
            if (!existing.has(column)) {
                await db.prepare(alter).run()
            }
        }
    }

    // 3. 索引（IF NOT EXISTS 幂等）
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_albums_user_id ON albums(user_id)').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_album_images_album_id ON album_images(album_id)').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_album_shares_album_id ON album_shares(album_id)').run()

    albumSchemaChecked = true
}
