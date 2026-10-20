import type {Express} from 'express';
import type {Pool} from 'pg';
import {apiRoute} from '../shared/route';
import {fixedService} from './service';
import {payOccurrence} from './pay';
// Solo administradores: el integrante no ve obligaciones, importes ni vencimientos. Registrar antes de registerDatabaseApi.
export function registerFixedExpenses(app:Express,pool:Pool|null){
 const route=apiRoute(pool);
 app.get('/api/fixed-expenses',route(async(_req,res,db,family)=>{res.json({fixedExpenses:await fixedService(db,family).list()});}));
 app.post('/api/fixed-expenses',route(async(req,res,db,family)=>{res.status(201).json({fixedExpense:await fixedService(db,family).create(req.body)});}));
 app.get('/api/fixed-expenses/occurrences',route(async(req,res,db,family)=>{res.json({occurrences:await fixedService(db,family).occurrences(req.query.month as string)});}));
 app.get('/api/fixed-expenses/overdue',route(async(_req,res,db,family)=>{res.json({occurrences:await fixedService(db,family).overdue()});}));
 app.post('/api/fixed-expenses/occurrences/:id/pay',route(async(req,res,db,family,actor)=>{res.status(201).json({expense:await payOccurrence(db,family,actor,req.params.id,req.body)});}));
 app.get('/api/fixed-expenses/unlinked',route(async(req,res,db,family)=>{res.json({expenses:await fixedService(db,family).unlinked(req.query.month as string)});}));
 app.post('/api/fixed-expenses/occurrences/:id/link',route(async(req,res,db,family)=>{await fixedService(db,family).link(req.params.id,req.body?.expenseId);res.sendStatus(204);}));
 app.delete('/api/fixed-expenses/occurrences/:id/link',route(async(req,res,db,family)=>{await fixedService(db,family).unlink(req.params.id);res.sendStatus(204);}));
 app.patch('/api/fixed-expenses/:id',route(async(req,res,db,family)=>{res.json({fixedExpense:await fixedService(db,family).update(req.params.id,req.body)});}));
}
