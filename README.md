# htmldrop

把一個 HTML 檔案變成一個可以傳給別人的連結。丟進去、拿到網址、傳出去，沒有別的功能。

- **上傳頁**：<https://htm1drop.pages.dev>
- **分享連結長這樣**：`https://pub-c8f72066867d4679a4095d2b9e00b1c6.r2.dev/m/k3f9a2b1cd`

---

## 怎麼用

1. 打開上傳頁，第一次會要你輸入上傳密碼（之後這台裝置會記住）。
2. 把 `.html` 檔案**拖進去**，或點一下選檔案，或直接 **Ctrl/⌘+V 貼上 HTML 原始碼**。
3. 上傳完連結會自動複製到剪貼簿，傳出去就好。

上傳前可以選保存期限：**7 天 / 30 天 / 永久**（預設 30 天）。過期的檔案由 Cloudflare 自動刪除，不用管。

「最近分享」的清單只存在你自己瀏覽器的 localStorage，換裝置看不到。

---

## 架構

```
瀏覽器
  ├─ 算 SHA-256 → 產生 10 碼短代號（同樣內容 = 同樣網址）
  ├─ 用 CompressionStream 做 gzip
  └─ POST /api/upload
        │
        ▼
Cloudflare Pages（靜態頁面，免費、不限流量）
  └─ functions/api/upload.js ← 唯一會用到 Workers 的地方
        │ 驗證密碼 → 寫進 R2
        ▼
R2 bucket「htmldrop」（公開讀取）
        │
        ▼
朋友點開 pub-xxx.r2.dev/m/xxxx ← 完全不經過 Workers
```

### 為什麼這樣設計（成本考量）

| 決定 | 省下什麼 |
|------|----------|
| 前端是純靜態 HTML/CSS/JS，沒有 build step | Pages 靜態請求免費且不限量；CI 也不用跑打包 |
| **讀取直接走 R2 公開網址** | 每次「被點開」都不會觸發 Workers，Workers 用量只跟「上傳次數」有關 |
| **gzip 在瀏覽器做**，Worker 只負責轉手 | R2 儲存空間少 ~75%（實測 3.0 KB → 131 B），Worker CPU 幾乎是 0 |
| **key = 內容雜湊**，上傳前先 `head()` 檢查 | 重複上傳同一份檔案不會重複佔空間，也省下較貴的寫入次數 |
| **lifecycle 自動刪除** | 7 天 / 30 天的檔案自動清掉，儲存量不會一直長 |
| 靠 `Cache-Control` 讓 CDN 擋掉重複讀取 | 減少 R2 的 Class B 讀取次數 |

實際費用：**$0**。R2 免費額度是每月 10 GB 儲存、100 萬次寫入、1000 萬次讀取；Pages Functions 免費額度是每天 10 萬次請求 —— 而這裡只有「上傳」會用到 Functions。

### 保存期限是怎麼實作的

用 key 前綴分流，再讓 R2 的 lifecycle 規則自己刪，完全不需要排程或 Worker：

| 前綴 | 期限 | R2 lifecycle 規則 |
|------|------|-------------------|
| `w/` | 7 天 | `expire-7d` |
| `m/` | 30 天 | `expire-30d` |
| `p/` | 永久 | 無 |

```bash
npx wrangler r2 bucket lifecycle list htmldrop
```

---

## 本地開發

```bash
npm install
cp .dev.vars.example .dev.vars   # 填一個本地用的 UPLOAD_KEY
npm run dev                      # http://localhost:8788
```

本地跑的時候 R2 是 miniflare 模擬出來的，上傳會成功但產生的分享連結不會真的存在——要測真的連結請部署到 Pages。

---

## 部署

推到 `main` 就會由 GitHub Actions 自動部署（`.github/workflows/deploy.yml`）。

需要先在 GitHub repo 的 **Settings → Secrets and variables → Actions** 設定兩個 secret：

| Secret | 值 |
|--------|-----|
| `CLOUDFLARE_ACCOUNT_ID` | `be5f9e827161c443f2ec29b99bfae347` |
| `CLOUDFLARE_API_TOKEN` | 到 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 用 **Edit Cloudflare Workers** 範本建一個，或自訂權限：`Account → Cloudflare Pages → Edit` |

也可以手動部署：

```bash
npm run deploy
```

### 改上傳密碼

```bash
npx wrangler pages secret put UPLOAD_KEY --project-name htm1drop
npx wrangler pages secret put UPLOAD_KEY --project-name htm1drop --env preview
```

密碼存在 Cloudflare 的 secret 裡，不在這個 repo 內。改完之後所有裝置都要重新輸入一次。

---

## 之後想升級的話

- **換成自己的網域**：把網域加進 Cloudflare，在 R2 bucket 設定 Custom Domain（例如 `h.example.com`），然後把 `wrangler.jsonc` 裡的 `PUBLIC_BASE` 換掉。分享連結會變短，而且不再受 `r2.dev` 的速率限制。
- **刪掉某個分享**：`npx wrangler r2 object delete htmldrop/m/<代號> --remote`

## 注意

- 分享連結是**公開**的，任何拿到網址的人都能看。網址不好猜（約 51 bits），但不是權限控制。
- 上傳的 HTML 會在 `r2.dev` 這個網域上執行，跟上傳頁不同源，不會影響上傳頁。
- 上傳頁本身有 `noindex`，密碼是唯一的防線——別把密碼貼在公開的地方。
