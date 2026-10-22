import type {Express} from 'express';
import type {Pool} from 'pg';
import {apiRoute} from '../shared/route';
import {budgetService} from './service';
// Solo administradores: un integrante nunca ve importes presupuestados. Registrar antes de registerDatabaseApi.
export function registerBudgets(app:Express,pool:Pool|null){
 const route=apiRoute(pool);
 app.get('/api/budgets',route(async(req,res,db,family,actor)=>{res.json(await budgetService(db,family,actor.memberId).report(req.query.month as string));}));
 // Presupuesto base recurrente (se renueva solo cada mes). Antes que las rutas por mes: 'base' no es un mes.
 app.put('/api/budgets/base/:categoryId',route(async(req,res,db,family,actor)=>{
  await budgetService(db,family,actor.memberId).setBase(req.params.categoryId,req.body?.amount,req.body?.from);res.sendStatus(204);
 }));
 app.delete('/api/budgets/base/:categoryId',route(async(req,res,db,family,actor)=>{
  await budgetService(db,family,actor.memberId).endBase(req.params.categoryId,req.query.from);res.sendStatus(204);
 }));
 app.put('/api/budgets/:month/:categoryId',route(async(req,res,db,family,actor)=>{
  await budgetService(db,family,actor.memberId).set(req.params.month,req.params.categoryId,req.body?.amount);res.sendStatus(204);
 }));
 app.delete('/api/budgets/:month/:categoryId',route(async(req,res,db,family,actor)=>{
  await budgetService(db,family,actor.memberId).remove(req.params.month,req.params.categoryId);res.sendStatus(204);
 }));
 app.post('/api/budgets/copy',route(async(req,res,db,family,actor)=>{
  res.json({copied:await budgetService(db,family,actor.memberId).copy(req.body?.from,req.body?.to)});
 }));
}
