# PROMPTS.md
## AI Usage and Development Notes – BalanceVault

### Overview

During the development of BalanceVault, I used Claude (Anthropic) as my primary AI coding assistant. I also used AI tools to understand technical concepts, troubleshoot errors, review implementation decisions, and improve the overall project structure.

Claude helped generate the initial implementation of the backend (Express and PostgreSQL), React frontend, SQL migrations, automated tests, and project documentation.

My role involved setting up the development and deployment environments, running the application, testing its functionality, identifying issues, and resolving problems encountered during development.

I made sure to review important parts of the implementation, particularly authentication, authorization, account ownership, ledger operations, and audit logging, rather than relying entirely on generated code.

**Technology clarification:** An earlier project description mentioned Prisma and separate database roles. The final implementation uses PostgreSQL with plain SQL migrations and a single database role. The final implementation, rather than the earlier description, reflects the actual project.

---

## Development History

### 1. Initial Project Implementation – November 9, 2026

I started by using Claude to generate the initial version of BalanceVault, covering the main requirements:

- User authentication and role-based access.
- Account-holder registration and onboarding.
- Account management.
- Ledger and transaction tracking.
- Audit logging.
- API rate limiting.
- Health and readiness endpoints.
- Frontend and backend integration.

Claude generated the initial codebase, including the frontend, backend, database migrations, tests, and documentation.

However, the generated implementation had not been tested against a real database environment. I treated it as an initial implementation rather than assuming everything would work correctly.

I configured Neon, ran the database migrations, and executed the automated tests against a test database branch before relying on the implementation.

**Commit reference:** [Add first commit link]

### 2. Fixing an Issue in the Automated Test Helper – November 9, 2026

While running the security tests, I encountered an issue in the shared API test helper.

The helper function was sending a JSON body with every HTTP request, including GET requests.

During the initial test run, 22 tests passed and one failed. The failure was caused by Node.js 22 Fetch API rejecting a request body on GET and HEAD methods.

This meant the test was failing before the request even reached the backend.

I investigated the error and updated `tests/helpers.js` so that GET requests do not include a request body.

After the correction, all 23 tests passed.

This helped me understand the importance of checking whether a test is actually reaching the application before interpreting its result.

**Commit reference:** [Add fix commit link]

### 3. Resolving Database Configuration and Windows Command-Line Issues – November 9, 2026

During database setup and testing, I faced an issue while executing environment-variable commands in Windows Command Prompt.

The initial commands used PowerShell syntax, which was not compatible with my terminal.

I also noticed that my Neon connection URL contained an ampersand (`&channel_binding=require`). In Windows CMD, the ampersand is treated as a command separator when it is not handled correctly.

As a result, the database URL was being split, and part of it was interpreted as a separate command.

I checked the command syntax and corrected it by using CMD-compatible environment variable assignment:

`set "DATABASE_URL=your_database_connection_url"`

This resolved the command-line configuration issue and helped me understand how environment variables and special characters behave differently across terminals.

**Commit reference:** Not applicable – local configuration fix.

---

## Security and Implementation Verification

### 4. Understanding and Verifying Role-Based Authorization

One important requirement of BalanceVault is ensuring that regular account holders cannot access administrative functionality.

The backend uses authentication middleware and role-based authorization through `requireAuth` and `requireRole('ADMIN')`.

I reviewed the middleware in `backend/src/auth.js` and the way it is applied to administrative routes.

The important distinction I checked was how the application determines a user's current role. Authorization should not rely only on an outdated role stored in a token if the user's permissions have subsequently changed.

I also planned a direct API test using a normal account-holder token against an administrative endpoint.

The expected result is HTTP 403 Forbidden, confirming that an authenticated user without administrative privileges cannot access the endpoint.

**Verification details to complete:**
- Role source: [Write what the actual middleware uses after inspecting the code.]
- API test result: [Record the actual HTTP status code.]
- Any issue identified: [Describe only if an issue was found.]

### 5. Account Ownership and Access Restrictions

Another important security requirement is ensuring that one account holder cannot access another user's account information or perform operations on their behalf.

I reviewed the account and money-related routes, particularly:

- `routes/accounts.js`
- `money.js`

The implementation uses authenticated-user-based account lookup for holder operations through routes such as `/api/accounts/me/...`.

This design is important because account ownership should be determined by the authenticated user on the server rather than trusting an account ID supplied by the frontend.

I focused on checking whether client-provided account IDs could be used to access another user's balances or initiate unauthorized operations.

I also reviewed the corresponding tests, including the test for balances being isolated per user.

**Verification details to complete:**
- Account ID handling: [Record what you actually found in the route implementation.]
- Relevant test: [Record the exact test name.]
- Any additional correction: [Describe your actual change, or state that no change was necessary.]

### 6. Audit Trail and Protection Against Unauthorized Changes

BalanceVault maintains an audit log to provide a record of important system operations.

The implementation uses a hash-chained audit log and database triggers intended to prevent modifications through UPDATE, DELETE, and TRUNCATE operations.

I reviewed the audit logging implementation to understand how entries are connected through hashes and how database-level protections are applied.

I also prepared a verification step using the Neon SQL editor on the test database branch.

The purpose is to attempt an UPDATE operation against an audit-log entry and confirm that the database rejects the modification.

The hash chain provides an additional integrity mechanism: changing an earlier entry can cause subsequent hash verification to fail, making unauthorized modifications detectable.

**Verification details to complete:**
- UPDATE test result: [Record the actual database error.]
- Trigger behaviour: [Record which operations were rejected.]
- Any issue identified: [Describe what you found and corrected, if applicable.]

---

## Final Reflection

Working on BalanceVault helped me understand that building a secure application involves more than implementing frontend screens and backend APIs.

I gained practical experience with database configuration, API testing, authentication, role-based access control, account ownership, and audit logging.

Using AI tools accelerated the initial development process, but running the application, investigating errors, validating assumptions, and understanding the security implementation were essential parts of my work.

One of my biggest takeaways was that generated code should never be considered correct simply because it looks reasonable. It needs to be tested in the actual environment, and its behaviour must be understood before relying on it.