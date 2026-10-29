import { Router } from 'express';
import { pendiente } from '../../shared/problem.js';
const router = Router();
router.get('/', pendiente);
router.post('/', pendiente);
router.get('/:id', pendiente);
router.patch('/:id', pendiente);
export default router;
