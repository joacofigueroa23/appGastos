import type { Express, Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { expenseService, resolveFamilyId } from './service';
import { validateExpenseFilters } from './validation';
import { listCategories } from './repository';
import { ApiError } from '../shared/errors';
import {referenceService} from '../family/service';
import {sessionMember} from '../accounts/session';

export function registerDatabaseApi(app: Express, pool: Pool | null, familyOverride?: string): void {
  const route = (handler: (req: Request,res: Response,db: Pool,familyId: string) => Promise<unknown>) =>
    async (req: Request,res: Response,next: NextFunction) => {
      try {
        if (!pool) throw new ApiError(503,'Configura DATABASE_URL para usar PostgreSQL.');
        const familyId = familyOverride || await resolveFamilyId(pool);
        await handler(req,res,pool,familyId);
      } catch (error) { next(error); }
    };
  app.get('/api/expenses',route(async (req,res,db,family) => {
    res.json({ expenses: await expenseService(db,family).list(validateExpenseFilters(req.query)) });
  }));
  app.post('/api/expenses',route(async (req,res,db,family) => {
    res.status(201).json({ expense: await expenseService(db,family,sessionMember(res)?.id).createExpense(req.body) });
  }));
  app.get('/api/expenses/:id',route(async (req,res,db,family) => {
    res.json({ expense: await expenseService(db,family).get(req.params.id) });
  }));
  app.patch('/api/expenses/:id',route(async (req,res,db,family) => {
    res.json({ expense: await expenseService(db,family,sessionMember(res)?.id).update(req.params.id,req.body) });
  }));
  app.delete('/api/expenses/:id',route(async (req,res,db,family) => {
    await expenseService(db,family).delete(req.params.id); res.sendStatus(204);
  }));
  app.get('/api/categories',route(async(_req,res,db,family)=>{
    res.json({categories:await listCategories(db,family)});
  }));
  for(const [path,kind,listKey,itemKey] of [
    ['/api/cards','cards','cards','card'],
    ['/api/family-members','family_members','members','member'],
  ] as const){
    app.get(path,route(async(_req,res,db,family)=>{res.json({[listKey]:await referenceService(db,family,kind).list()});}));
    app.post(path,route(async(req,res,db,family)=>{res.status(201).json({[itemKey]:await referenceService(db,family,kind).create(req.body)});}));
    app.patch(path+'/:id',route(async(req,res,db,family)=>{res.json({[itemKey]:await referenceService(db,family,kind,!!sessionMember(res)).update(req.params.id,req.body)});}));
  }
  app.use('/api', (error: any,_req: Request,res: Response,_next: NextFunction) => {
    if (error instanceof ApiError) { res.status(error.status).json({ error: error.message }); return; }
    if (['23503','23514','22P02','22003','22007','22008'].includes(error?.code)) { res.status(400).json({ error: 'Datos inválidos para PostgreSQL.' }); return; }
    if (error?.constraint === 'family_members_active_phone_uidx') { res.status(409).json({ error: 'Ese número ya está asignado a otro integrante activo.' }); return; }
    if (error?.code === '23505') { res.status(409).json({ error: 'Ya existe un registro con ese nombre.' }); return; }
    if (error?.status === 400) { res.status(400).json({error:'JSON inválido.'}); return; }
    console.error('API PostgreSQL: fallo de conexion.', typeof error?.code === 'string' ? error.code : /timeout|timed out/i.test(error?.message || '') ? 'CONNECTION_TIMEOUT' : 'DATABASE_ERROR');
    res.status(503).json({ error: 'PostgreSQL no está disponible o faltan migraciones. Revisa la configuración del servidor.' });
  });
  app.use('/api',(_req:Request,res:Response)=>{res.status(404).json({error:'Endpoint inexistente.'});});
}
