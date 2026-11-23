# Municipal Management System

Local development requires Node.js 26 and uses its built-in SQLite support. The application listens on 127.0.0.1 only. There are no package installs or external services.

## Run locally

For a synthetic preview, run node server.js --demo. Choose Admin to enter the synthetic demo without a password. Demo records reset on restart. It uses an in-memory database.

For the persistent local workspace, provision the first administrator using node server.js --create-account with MMS_ACCOUNT and MMS_PASSWORD set through a private local terminal session. MMS_ROLE defaults to admin. Use a unique passphrase with at least 15 characters and clear the variables immediately after provisioning. Run node server.js to start the workspace. MMS_PORT defaults to 8765 and MMS_DB defaults to mms-demo.sqlite. The persistent workspace contains the legacy synthetic records. Keep it limited to synthetic records until the production controls and legal review are complete.

Run node --test regression.test.js to exercise the local HTTP API using a dedicated temporary SQLite database. The suite uses loopback port 18765.

## Architecture and status

| Area | Status | Evidence and remaining work |
| --- | --- | --- |
| Preservation | TESTED | Source hashes, SQLite backup integrity and record equality verified. Baseline committed to Git. |
| Identity and shared platform | PARTIAL | Staff credentials with scrypt, opaque revocable sessions, login throttling, server RBAC, versioned routes and chained audit records. MFA, account recovery and deactivation, permission configuration, retention policies, department isolation, and external audit anchoring remain. |
| Tax and Revenue | PARTIAL | Registration, statements, assessments billed directly, partial payment, idempotent payment retries, printable receipts, reversal approvals, debt aging, revenue ledger, daily collections and CSV. Tax schedules, assessment review and revision, refunds, collection-officer assignment and bank reconciliation remain. |
| Finance | NOT STARTED | The revenue subledger provides a future integration source. A chart of accounts, treasury, budgets, expenditure workflows, general ledger and statements require implementation. |
| Administration | NOT STARTED | Staff login provisioning exists in the identity module. Employee and department records, assets, procurement, documents, attendance and leave require implementation. |
| Social Affairs | NOT STARTED | Case and service workflows, referrals, privacy-scoped access and community programs require implementation. |
| Cross-department integration | NOT STARTED | Shared HTTP routing exists. Department grants, isolation, cross-department approvals, notifications and sharing require implementation. |
| Responsive UI and localization | PARTIAL | Original navy layout and reduced-motion support preserved. Somali translation, department dashboards and a complete WCAG 2.2 AA assessment remain. |
| Deployment readiness | PARTIAL | Loopback and isolated backup/restore tests verified. Public deployment, PostgreSQL evaluation, operational monitoring, external security review and jurisdiction-specific controls remain. |

## Identity and audit

Identity establishes staff authentication and validates global revenue roles. Administrator accounts provision staff, issue bills, register taxpayers, access audit records and approve reversals requested by another account. Cashiers record payments and request reversals. Viewers read the revenue register. Everyone uses their own account. The server authorizes every write and rejects cross-origin requests. The role selector and trusted role header from the baseline have been removed.

Migration 1 adds users, sessions, audit actor IDs and SHA-256 audit digests. Username uniqueness is enforced. Session tokens are random and only their digests are stored. The local HTTP session cookie is HttpOnly and SameSite=Strict, with an eight-hour absolute lifetime. Logout revokes the server-side session. The API serves session, login, logout and accounts under /api/v1. Sign-in, sign-out, account creation and revenue writes are audited. The hash chain detects ordinary record edits but a database administrator can rewrite or truncate it. Keep externally anchored audit records and TLS-backed Secure cookies in the production security design.

## Tax and Revenue

Taxpayers have numeric internal identifiers displayed as T- references. Each bill belongs to a taxpayer and each payment belongs to a bill. Bills and payments use integer USD cents. Assessments are entered manually with a description, amount and due date. There are no preconfigured tax rates. Tax categories, approved rates, currency, timezone and municipal accounting rules require jurisdiction-specific configuration before live use.

The state, taxpayers, bills, payments, reversals and approve-reversal API routes are under /api/v1. Payments require an Idempotency-Key. A replay with the same authenticated account, bill and amount returns the original receipt. A different payload or actor using the same key receives a conflict. Other changes use separate authorization and input rules. Financial writes and their audit entries commit together. Legacy /api/ routes continue to use the same authenticated handlers.

Migration 2 adds revenue_ledger, payment_requests and query indexes. Each ledger row stores the same integer amount for one debit and one credit account, with a unique source. Existing bills are backfilled with an unknown posting date. Migration 3 adds payment_reversals, the bill_balances view and the revenue_postings view. A reversal preserves the original receipt and requires request and approval by different staff accounts. Approval reopens the bill balance and exposes a compensating receivables/cash entry. The workflow records a full bookkeeping reversal. Treasury disbursement and partial refunds require a separate implementation. Tests cover transaction concurrency, invalid dates, overpayments, retries, reversals and original receipt retention.

## Backup and recovery

The verified pre-change snapshot is under .backups and excluded from Git. Create a fresh snapshot before upgrades using node database-tool.js backup <destination.sqlite>. The tool uses SQLite's online backup API and checks integrity before it reports success. Verify a backup using node database-tool.js verify <destination.sqlite>.

To rehearse recovery, select a separate local destination file and run node database-tool.js restore <backup.sqlite> <rehearsal.sqlite>. Start the application against the rehearsal file through MMS_DB, inspect the records, and run the checks before any controlled production cutover. For an actual recovery, stop the server and switch MMS_DB to the verified restored file, keeping the previous database available until sign-off. These recovery commands refuse to overwrite an existing file.

## Deployment boundaries

The current server is intended for local development. A future deployment needs TLS, secure cookies, managed secrets, least-privilege host and database access, central identity policy, tested restore and retention schedules, and external validation. The control design should be reviewed against OWASP ASVS, ISO/IEC 27001 and ISO/IEC 27701. Accounting design requires municipal approval and an IPSAS-informed review. No compliance or certification determination has been made.
## Verification record

The baseline application was exercised over local HTTP before changes. The migrated workspace was compared with its pre-change backup. Taxpayers, bills, payments, settings and legacy audit fields matched, and migrations 1 through 3 were present. Backup creation and restoration were verified with SQLite integrity and foreign-key checks.

The automated regression suite passed sign-in, session revocation, forged role rejection, cross-origin rejection, date validation, partial payments, concurrent overpayment rejection, payment retries, audit digest checks, and reversal approval and balance restoration. In the isolated browser demo, a cashier requested a reversal and a different administrator approved it. The browser showed the reversal on the original receipt and rendered taxpayer statements, daily reports and the dashboard at a 390 px viewport.
