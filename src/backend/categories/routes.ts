import type {Express} from 'express';
import type {Pool} from 'pg';
import {apiRoute} from '../shared/route';
import {categoryService} from './service';
// Solo administradores crean, renombran, reorganizan, archivan y reactivan categorías. La lectura (GET /api/categories) sigue abierta
// a los integrantes, que las usan al registrar gastos. Registrar antes de registerDatabaseApi.
export function registerCategories(app:Express,pool:Pool|null){
 const route=apiRoute(pool);
 app.post('/api/categories',route(async(req,res,db,family)=>{res.status(201).json({category:await categoryService(db,family).create(req.body)});}));
 app.patch('/api/categories/:id',route(async(req,res,db,family)=>{res.json({category:await categoryService(db,family).update(req.params.id,req.body)});}));
}
