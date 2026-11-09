import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { record } from '../audit.js';
import { HttpError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';

const appSchema = z
  .object({
    phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'phone must be 10-15 digits'),
    address: z.string().trim().min(5).max(300),
    // A reference string only (demo uses synthetic data, no document upload).
    idDocumentRef: z.string().trim().min(3).max(100),
  })
  .strict();

const r = Router();
r.use(requireAuth, requireRole('ACCOUNT_HOLDER'));

r.post('/', async (req, res) => {
  const b = appSchema.parse(req.body);
  try {
    const application = await withTx(async (c) => {
      const { rows: ex } = await c.query('SELECT id, status FROM onboarding_applications WHERE user_id = $1 FOR UPDATE', [
        req.user.id,
      ]);
      let row;
      if (ex[0]) {
        if (ex[0].status !== 'REJECTED') throw new HttpError(409, `application already ${ex[0].status.toLowerCase()}`);
        ({ rows: [row] } = await c.query(
          `UPDATE onboarding_applications
              SET phone=$2, address=$3, id_document_ref=$4, status='PENDING',
                  reviewed_by=NULL, reviewed_at=NULL, review_note=NULL
            WHERE id=$1 RETURNING *`,
          [ex[0].id, b.phone, b.address, b.idDocumentRef],
        ));
      } else {
        ({ rows: [row] } = await c.query(
          `INSERT INTO onboarding_applications(user_id, phone, address, id_document_ref)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [req.user.id, b.phone, b.address, b.idDocumentRef],
        ));
      }
      await record(c, {
        actorId: req.user.id,
        actorRole: req.user.role,
        action: 'ONBOARDING_SUBMITTED',
        target: `application:${row.id}`,
        ip: req.ip,
      });
      return row;
    });
    res.status(201).json({ application });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'application already exists');
    throw e;
  }
});

// Scoped by user_id from the token: there is no way to ask for someone else's application.
r.get('/me', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, phone, address, id_document_ref, status, review_note, created_at, reviewed_at FROM onboarding_applications WHERE user_id = $1',
    [req.user.id],
  );
  res.json({ application: rows[0] ?? null });
});

export default r;
