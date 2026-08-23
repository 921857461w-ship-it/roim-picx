-- 目录元数据表：记录用户创建的目录（含空目录），用于目录导航实时展示
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,              -- 完整目录路径，以 / 结尾，如 'a/b/'
    user_login TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (path, user_login)
);

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_login);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders (path);
