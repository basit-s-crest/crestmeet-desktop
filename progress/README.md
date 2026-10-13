# CrestMeet — Project-Scoped Chatbot & RAG Development Progress

> **Tracking progress against:** [CHATBOT_DEVELOPMENT_README.md](file:///c:/Projects-Crest/meetily/CHATBOT_DEVELOPMENT_README.md)  
> **Last Updated:** 2026-10-13  
> **Current Status:** Phase 1, Phase 2, Phase 3, and Phase 4 are 100% Complete!

---

## 1. Executive Roadmap & Status Matrix

| Phase | Description | Status | Progress |
|---|---|:---:|:---:|
| **Phase 1** | **Projects & Membership** (Tenant boundary, roles, project switcher, UI context) | ✅ Completed | 100% |
| **Phase 2** | **Knowledge Base Pipeline** (Chunking, enrichment, embeddings, insights, indexing jobs) | ✅ Completed | 100% |
| **Phase 3** | **Chatbot v2 & Chat Product** (`chat_sessions`, history sidebar, streaming, citations, memory) | ✅ Completed | 100% |
| **Phase 4** | **Sharing & Export** (Immutable snapshots, members-only/public links, Markdown/PDF export) | ✅ Completed | 100% |
| **Phase 5** | **Public Links, Quality & Agent Mode** (Read-only tools, web viewer, reranking) | ⏳ Next | 0% |
| **Phase 6** | **Advanced Capabilities** (Branching, org tier, offline local-LLM) | ⏳ Queued | 0% |

---

## 2. Detailed Phase Breakdown & Checklist

### Phase 1: Projects & Membership Foundation
- [x] `projects`, `project_members`, `project_invitations` database tables & constraints
- [x] Role hierarchy (`owner`, `admin`/`team_leader`, `member`, `viewer`)
- [x] Project switcher & multi-tenant UI context in Next.js
- [x] Meeting attribution to `project_id`
- [x] Member invitation and role management UI

---

### Phase 2: Knowledge Base Pipeline
- [x] **P2-1: Speaker-Turn Chunker**
  - Speaker turns windowing (250–350 tokens, max 450, 1-turn overlap)
  - Retain `start_seconds`, `end_seconds`, speaker labels, transcript IDs
  - Implemented in `services/rag_service/src/crestmeet_rag/chunking/chunker.py`
- [x] **P2-2: Embedding Benchmark & Model Selection**
  - Pinned on-device inference (`bge-small-en-v1.5@1` 384-d using FastEmbed ONNX)
- [x] **P2-3: Local Embedder & Inference Engine**
  - Pinned on-device inference (`bge-small-en-v1.5@1` 384-d using FastEmbed ONNX)
  - Implemented in `services/rag_service/src/crestmeet_rag/embeddings/embedder.py`
- [x] **P2-4: Contextual Enrichment & Insight Extractor**
  - Context header: `{Project | Meeting | Date | Speakers}`
  - Extract `meeting_insights` (decisions, action items, risks, deadlines)
- [x] **P2-5: Summary Chunks & Project Briefs**
  - Chunk and embed AI summaries (`source_type = 'summary'`) into `knowledge_chunks`
  - Auto-generate and maintain `project_briefs` (~300 tokens aggregating key decisions and open tasks)
  - Implemented in `services/rag_service/src/crestmeet_rag/indexing.py`
- [x] **P2-6: Resumable Indexing Pipeline (`indexing_jobs`)**
  - Track stages in `indexing_jobs` (`chunk`, `embed`, `insights`, `done`)
  - Post-recording background indexing hook wired to `api_save_transcript`
- [x] **P2-7: Backfill & Re-indexing**
  - Executed batch indexing: 38/38 meetings processed, 138 chunks embedded and stored in Supabase pgvector!

---

### Phase 3: Chatbot v2 (Fast Path) & ChatGPT-Style Chat Product
- [x] **P3-1: Chat Schema & Migration**
  - Create `chat_sessions` with monotonic message ordering (`seq`), `knowledge_chunks`, `meeting_insights`, `indexing_jobs`
  - Integrated into `manager.rs` and standalone migration `20261013000000_chatbot_rag_schema.sql`
- [x] **P3-2: Scope Enforcement & Hybrid RRF Search**
  - `resolve_scope(project_ids)` in PostgreSQL
  - `search_knowledge` combining pgvector cosine distance + FTS with RRF fusion
- [x] **P3-3: Real-Time Token Streaming & Generation**
  - Tauri `Channel<ChatStreamEvent>` integration for word-by-word streaming
  - Groq SSE client with line-by-line streaming parser
- [x] **P3-4: Server-Verified Citations (`[S#]`)**
  - Validate model references against retrieved chunks
  - Citations rendered with clickable source chips and date/time references
  - [x] **P3-4b: Deep-Link Citation Navigation**
    - Click citation chip → navigate to meeting detail view (`/meeting-details?id=...&t=...`)
    - Jump directly to timestamp and auto-highlight the cited transcript excerpt with glowing pulse indicator
    - Seek synchronized screen recording / audio playback directly to cited moment
  - [x] **P3-5: Conversation Memory (Rolling Summary & History-Aware Rewrite)**
    - Anchor first user query as overarching topic / intent
    - Last 6 turns (3 user + 3 assistant) passed verbatim in context with collision-safe citation sanitization
    - History-aware query rewriter transforms conversational follow-ups (e.g. "What about the budget?", "Who said that?") into standalone search queries for pgvector + FTS
    - Background Groq calls automatically maintain `chat_sessions.title` (auto-titling) and `chat_sessions.summary` (rolling summary for turns > 6)
  - [x] **P3-6: History Panel UI (Left Sidebar)**
  - Grouped by Pinned / Today / Yesterday / Previous 7 Days / Previous 30 Days / Older
  - Integrated `ChatHistorySidebar` with rename inline, pin/unpin, archive, delete, and search filtering
  - [x] **P3-7: Turn Controls & Clipboard Actions**
  - Copy response with formatted Markdown citations, clear history, suggested prompt starters
  - Interactive project scope switcher with full multi-tenant isolation

---

### Phase 4: Sharing & Export
- [x] **P4-1: `chat_shares` & `chat_share_messages` Immutable Snapshots**
  - Secure token generation (`csh_...`) with PostgreSQL SHA-256 hashing via `encode(digest($token, 'sha256'), 'hex')`
  - Deep snapshot copying of messages and citations into `chat_share_messages`
  - Source privacy toggle (`include_sources`) stripping citations when disabled
  - Implemented in `src-tauri/src/chat/sharing.rs` (`ChatShareRepository::create_share`)
- [x] **P4-2: Members-Only Deep-Link Sharing & Forking ("Continue in my chats")**
  - `api_chat_get_shared` resolving snapshots by token hash, validating expiry and revocation, incrementing view counts
  - `api_chat_fork_shared` copying frozen snapshot messages into a new personal chat session for ongoing dialogue
  - `api_chat_revoke_share` and `api_chat_list_shares` management commands
  - Exposed via Tauri IPC and registered in `src-tauri/src/lib.rs`
- [x] **P4-3: Share Dialog UI & Token Revocation Controls**
  - Built `frontend/src/components/Chat/ShareChatDialog.tsx`
  - Audience toggle (Project Members vs Anyone with Link), Citations inclusion switch, and Expiration selector (7d / 30d / 90d / Never)
  - Active links listing with view counters, remaining expiry, 1-click clipboard copy, and revocation button
- [x] **P4-4: Local Export to Markdown & PDF**
  - Implemented in `frontend/src/app/chat/page.tsx`:
  - **Export as Markdown (.md):** Generates structured markdown with session metadata, query responses, and formatted citation footnotes, auto-downloaded via browser blob.
  - **Export as PDF:** Clean `@media print` styles hiding sidebars and composers, producing professional printable PDFs via `window.print()`.

---

### Phase 5: Quality, Agent Mode & Public Links
- [ ] **P5-1: Public Link Sharing Toggle & Verification**
- [ ] **P5-2: Web Viewer (Static viewer with sanitized CSP & noindex)**
- [ ] **P5-3: Optional Reranker Integration (Cross-encoder or Groq LLM rerank)**
- [ ] **P5-4: Agent Mode with 6 Read-Only Tools**

---

## 3. Architecture & Standards Notes

### Python Integration Standard
If Python-based tooling or microservices are utilized (e.g. for golden-set benchmarking, embedding evaluation, or ML sidecar tasks):
- Location: Dedicated directory `services/rag_service/`
- Packaging: Standard PEP 621 `pyproject.toml` managed with `uv`
- Inference: FastEmbed ONNX engine pinned to `bge-small-en-v1.5` (384 dimensions)
- Database: Supabase PostgreSQL with `pgvector` and `pg_trgm` / FTS

---

## 4. Current Work Log
- **2026-10-13:**
  - Cleaned legacy progress files and initialized master tracking document aligned with `CHATBOT_DEVELOPMENT_README.md`.
  - Initialized isolated `services/rag_service/` managed via `uv` (PEP 621 `pyproject.toml`, `.python-version` pinned to 3.11).
  - Implemented `SpeakerTurnChunker` (250–350 token windows, 1-turn overlap, sentence boundary and speaker preservation).
  - Implemented `LocalEmbedder` using FastEmbed ONNX with pinned model `bge-small-en-v1.5@1` (384-d vectors).
  - Created standalone database migration `migrations/20261013000000_chatbot_rag_schema.sql` and updated `manager.rs` for automatic Supabase verification:
    * `knowledge_chunks` (pgvector 384-d, FTS `tsvector`, context header/note, SHA256 content hash).
    * `meeting_insights` (decisions, action items, risks, deadlines with FTS).
    * `project_briefs` and `indexing_jobs` (resumable pipeline tracking).
    * `chat_sessions` and enhanced `chat_messages` (monotonic sequence, status, feedback, traces).
    * `chat_shares` and `chat_share_messages` (immutable snapshot sharing).
    * `resolve_scope` and `search_knowledge` SQL RPC functions for hybrid vector + keyword retrieval with Reciprocal Rank Fusion (RRF).
  - Built `src-tauri/src/chat/sessions.rs` with `ChatSessionRepository` and exposed Tauri commands (`api_chat_list_sessions`, `api_chat_create_session`, `api_chat_rename_session`, `api_chat_pin_session`, `api_chat_archive_session`, `api_chat_delete_session`) registered in `lib.rs` (verified clean compilation with `cargo check`).
  - Built ChatGPT-style `ChatHistorySidebar` component ([ChatHistorySidebar.tsx](file:///c:/Projects-Crest/meetily/frontend/src/components/Chat/ChatHistorySidebar.tsx)) with smart temporal grouping (Pinned, Today, Yesterday, 7 Days, 30 Days, Older), search filtering, rename, pin/unpin, archive, and delete menus.
  - Upgraded [ChatPage.tsx](file:///c:/Projects-Crest/meetily/frontend/src/app/chat/page.tsx) with collapsible history sidebar, multi-session switching, response clipboard copy, and deep-link citation pills.
  - Executed batch indexing pipeline via `uv run python -m crestmeet_rag.indexing`: processed **38/38 meetings** (138 chunks with 384-d vectors stored in Supabase `knowledge_chunks` and `meeting_insights`).
  - Wired background post-recording indexing trigger into `api_save_transcript` in `api/api.rs`.
  - Implemented real-time token streaming with Tauri 2.0 `Channel<ChatStreamEvent>` and Groq SSE parser in `src-tauri/src/chat/mod.rs` (`api_chat_send_message_stream`).
  - Updated frontend chat canvas with word-by-word streaming rendering and inline pulsing status indicators.
  - **Completed P3-4b (Deep-Link Citation Navigation):** Clickable source chips with `[S#]` tags, timestamps, speaker attribution, and query params (`?id=...&t=...`). Added auto-scroll to exact excerpt with animated pulsing ring and video player timestamp seeking in [VirtualizedTranscriptView.tsx](file:///d:/crestmeet-desktop/frontend/src/components/VirtualizedTranscriptView.tsx).
  - **Completed P3-5 (Multi-Turn Conversation Memory):** Added `load_conversation_memory`, intent anchoring, 6-turn recent dialogue window with collision-safe citation sanitization, history-aware follow-up query rewriting via Groq, background auto-titling, and rolling summary compression in [chat/mod.rs](file:///d:/crestmeet-desktop/frontend/src-tauri/src/chat/mod.rs).
  - **Completed P2-5 (Summary Chunks & Project Briefs):** In `services/rag_service/src/crestmeet_rag/indexing.py`, added automated indexing of meeting AI summaries with `source_type = 'summary'` and generation of 300-token `project_briefs` aggregating decisions & action items.
  - **Completed Phase 4 (Sharing & Export):**
    * P4-1: Created `src-tauri/src/chat/sharing.rs` implementing immutable snapshots in `chat_shares` and `chat_share_messages` with Postgres pgcrypto SHA-256 token hashing.
    * P4-2: Implemented and registered Tauri IPC commands: `api_chat_create_share`, `api_chat_get_shared`, `api_chat_fork_shared` ("Continue in my chats"), `api_chat_revoke_share`, and `api_chat_list_shares`. Verified clean Rust compilation via `cargo check`.
    * P4-3: Built [ShareChatDialog.tsx](file:///d:/crestmeet-desktop/frontend/src/components/Chat/ShareChatDialog.tsx) with audience switcher (Team vs Link), citations toggle, expiration presets, active shares viewer, and revocation action.
    * P4-4: Implemented Export dropdown in [page.tsx](file:///d:/crestmeet-desktop/frontend/src/app/chat/page.tsx) with structured Markdown download (.md) and professional `@media print` PDF generation. Verified clean TypeScript build (`tsc --noEmit`).
