import React,{useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {FinanceContext} from './FinanceContext';
import {financeApi} from '../services/financeApi';
import {PAYMENT_LABELS,type ApiCard,type ApiCategory,type ApiExpense,type ApiMember,type ExpenseWrite,type CardWrite,type MemberWrite} from '../shared/apiTypes';
import type {Expense,FamilyMember} from '../types';
import {expensesForMonth,sumAmounts,todayDateOnly} from '../utils/finance';
export function DatabaseFinanceProvider({children}:{children:ReactNode}) {
 const [apiExpenses,setExpenses]=useState<ApiExpense[]>([]);
 const [categories,setCategories]=useState<ApiCategory[]>([]);
 const [apiCards,setCards]=useState<ApiCard[]>([]);
 const [apiMembers,setMembers]=useState<ApiMember[]>([]);
 const [activeMemberId,setActiveMemberId]=useState('');
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState<string|null>(null);
 const version=useRef(0);
 const refresh=useCallback(async()=>{
  const request=++version.current;setLoading(true);setError(null);
  try {
   const [e,c,k,m]=await Promise.all([financeApi.expenses(),financeApi.categories(),financeApi.cards(),financeApi.members()]);
   if(request!==version.current)return;
   setExpenses(e.expenses);setCategories(c.categories);setCards(k.cards);setMembers(m.members);
   setActiveMemberId(id=>m.members.some(member=>member.id===id&&member.active)?id:'');
  }catch(e){if(request===version.current)setError(e instanceof Error?e.message:'Error de conexión.');}
  finally{if(request===version.current)setLoading(false);}
 },[]);
 useEffect(()=>{void refresh();},[refresh]);
 // Read external expenses without resetting filters or showing loading spinners.
 useEffect(()=>{
  let disposed=false,inFlight=false;
  const sync=async()=>{
   if(disposed||inFlight||document.visibilityState==='hidden')return;
   inFlight=true;const request=version.current;
   try{
    const data=await financeApi.expenses();
    if(!disposed&&request===version.current){setExpenses(data.expenses);}
   }catch{/* Retain the last confirmed state; explicit refresh reports errors. */}
   finally{inFlight=false;}
  };
  const timer=setInterval(()=>void sync(),10000);
  const focus=()=>void sync();window.addEventListener('focus',focus);
  return ()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',focus);};
 },[]);

 const createDatabaseExpense=async(input:ExpenseWrite)=>{
  const {expense}=await financeApi.create(input);++version.current;
  setExpenses(p=>[expense,...p.filter(e=>e.id!==expense.id)]);setLoading(false);setError(null);return expense;
 };
 const updateDatabaseExpense=async(id:string,input:Partial<ExpenseWrite>)=>{
  const {expense}=await financeApi.update(id,input);++version.current;
  setExpenses(p=>p.map(e=>e.id===id?expense:e));setLoading(false);setError(null);return expense;
 };
 const deleteExpense=async(id:string)=>{
  await financeApi.remove(id);++version.current;setExpenses(p=>p.filter(e=>e.id!==id));setLoading(false);setError(null);
 };
 const createDatabaseCard=async(input:CardWrite)=>{
  const {card}=await financeApi.createCard(input);setCards(p=>[...p,card]);return card;
 };
 const updateDatabaseCard=async(id:string,input:Partial<CardWrite>)=>{
  const {card}=await financeApi.updateCard(id,input);++version.current;
  setCards(p=>p.map(c=>c.id===id?card:c));setLoading(false);setError(null);return card;
 };
 const createDatabaseMember=async(input:MemberWrite)=>{
  const {member}=await financeApi.createMember(input);++version.current;
  setMembers(p=>[...p,member]);setLoading(false);setError(null);return member;
 };
 const updateDatabaseMember=async(id:string,input:Partial<MemberWrite>)=>{
  const {member}=await financeApi.updateMember(id,input);++version.current;
  setMembers(p=>p.map(m=>m.id===id?member:m));
  if(!member.active)setActiveMemberId(previous=>previous===id?'':previous);
  setLoading(false);setError(null);return member;
 };
 // Adaptador de lectura para vistas anteriores; no escribe localStorage.
 const expenses:Expense[]=apiExpenses.map(e=>({
  id:e.id,date:e.date,amount:Number(e.amount),currency:e.currency,merchant:e.merchant||undefined,
  description:e.description,category:e.categoryName,categoryId:e.categoryId,paymentMethod:PAYMENT_LABELS[e.paymentMethod],
  cardId:e.cardId||undefined,reportedByMemberId:e.reportedByMemberId||undefined,paidByMemberId:e.reportedByMemberId||'',
  isShared:true,installmentTotal:1,installmentCurrent:1,source:e.source,createdAt:e.createdAt,
 }));
 const members:FamilyMember[]=apiMembers.map(m=>({
  id:m.id,name:m.name,avatar:'●',role:'member',color:'#2563EB',phoneNumber:m.phoneNumber||undefined,monthlyBudget:0,
 }));
 const currentMonthExpenses=expensesForMonth(expenses,todayDateOnly().slice(0,7));
 const outsideScope=()=>{throw new Error('Funcionalidad anterior preservada en modo demo; fuera de prioridad.');};
 return <FinanceContext.Provider value={{
  isDemoMode:false,members,activeMemberId,setActiveMemberId,cards:[],bills:[],expenses,currentMonthExpenses,
  apiExpenses,categories,apiCards,apiMembers,loading,error,refresh,createDatabaseExpense,updateDatabaseExpense,createDatabaseCard,updateDatabaseCard,createDatabaseMember,updateDatabaseMember,
  addExpense:outsideScope,deleteExpense,addBill:outsideScope,toggleBillPaid:outsideScope,deleteBill:outsideScope,
  addCard:outsideScope,deleteCard:outsideScope,addMember:outsideScope,updateMemberBudget:outsideScope,
  whatsappLogs:[],whatsappConfig:{verifyToken:'',phoneNumberId:'',accessToken:''},
  saveWhatsAppConfig:async()=>outsideScope(),simulateWhatsAppMessage:async()=>({success:false,replyMessage:'Simulador preservado en modo demo; no conectado a PostgreSQL.'}),
  refreshWhatsAppLogs:async()=>{},formatCurrency:(amount,currency='ARS')=>new Intl.NumberFormat('es-AR',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(amount),
  currentMonthSummary:{totalSpent:sumAmounts(currentMonthExpenses),sharedTotal:sumAmounts(currentMonthExpenses),personalTotal:0,totalPendingBills:0,nextVencimientosCount:0},
 }}>{children}</FinanceContext.Provider>;
}
