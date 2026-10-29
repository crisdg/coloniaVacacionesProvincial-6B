import { Router } from 'express';
import { pendiente } from '../../shared/problem.js';
const router = Router();
router.get('/', pendiente);
router.post('/', pendiente);
router.get('/:id', pendiente);
router.patch('/:id', pendiente);
router.post('/:id/cancelaciones', pendiente);
export default router;
