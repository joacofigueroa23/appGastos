import type {Express} from 'express';
import type {Pool} from 'pg';
import {apiRoute} from '../shared/route';
import {referenceDate} from '../whatsapp/candidate';
import {controlSummary} from './summary';
// Totales separados de gastos fijos y presupuestos variables. Solo administradores: un integrante no ve obligaciones ni presupuestos.
// Registrar antes de registerDatabaseApi.
export function registerControl(app:Express,pool:Pool|null){
 const route=apiRoute(pool);
 app.get('/api/control/summary',route(async(req,res,db,family)=>{res.json(await controlSummary(db,family,req.query.month as string,referenceDate(new Date())));}));
}
