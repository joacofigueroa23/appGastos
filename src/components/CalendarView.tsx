import React, { useState } from 'react';
import { useFinance } from '../context/FinanceContext';
import { CreditCard as CardType, BillDue } from '../types';
import {
  Calendar as CalendarIcon,
  Plus,
  CheckCircle2,
  Clock,
  CreditCard,
  Building2,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

export const CalendarView: React.FC = () => {
  const {
    bills,
    cards,
    members,
    toggleBillPaid,
    deleteBill,
    addBill,
    addCard,
    deleteCard,
    formatCurrency,
  } = useFinance();

  // Estado para el mes mostrado en el calendario
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Modales
  const [isAddBillOpen, setIsAddBillOpen] = useState(false);
  const [isAddCardOpen, setIsAddCardOpen] = useState(false);

  // Formulario nuevo servicio / factura
  const [newBillTitle, setNewBillTitle] = useState('');
  const [newBillCategory, setNewBillCategory] = useState('Servicios Básicos');
  const [newBillAmount, setNewBillAmount] = useState('');
  const [newBillDueDate, setNewBillDueDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [newBillAutoDebit, setNewBillAutoDebit] = useState(false);

  // Formulario nueva tarjeta
  const [newCardName, setNewCardName] = useState('');
  const [newCardBank, setNewCardBank] = useState('');
  const [newCardDigits, setNewCardDigits] = useState('');
  const [newCardClosing, setNewCardClosing] = useState<number>(20);
  const [newCardDue, setNewCardDue] = useState<number>(5);
  const [newCardLimit, setNewCardLimit] = useState<string>('1000000');
  const [newCardOwner, setNewCardOwner] = useState<string>(members[0]?.id || '');
  const [newCardColor, setNewCardColor] = useState<string>('#2563EB');

  // Cálculos del mes
  const now = new Date();
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed
  const monthName = currentDate.toLocaleString('es-AR', { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Días de la semana en español
  const daysOfWeek = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  // Agrupar vencimientos y tarjetas por día del mes
  const eventsByDay: Record<number, { bills: BillDue[]; cardClosings: CardType[]; cardDues: CardType[] }> = {};
  for (let d = 1; d <= daysInMonth; d++) {
    eventsByDay[d] = { bills: [], cardClosings: [], cardDues: [] };
  }

  bills.forEach((b) => {
    const bDate = new Date(b.dueDate);
    if (bDate.getFullYear() === year && bDate.getMonth() === month) {
      const day = bDate.getDate();
      if (eventsByDay[day]) {
        eventsByDay[day].bills.push(b);
      }
    }
  });

  cards.forEach((c) => {
    if (c.closingDay && eventsByDay[c.closingDay]) {
      eventsByDay[c.closingDay].cardClosings.push(c);
    }
    if (c.dueDay && eventsByDay[c.dueDay]) {
      eventsByDay[c.dueDay].cardDues.push(c);
    }
  });

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
    setSelectedDay(null);
  };

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
    setSelectedDay(null);
  };

  const handleCreateBill = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(newBillAmount.replace(/\./g, '').replace(',', '.'));
    if (!newBillTitle.trim() || isNaN(amount) || amount <= 0) return;

    addBill({
      title: newBillTitle.trim(),
      serviceCategory: newBillCategory,
      amount,
      dueDate: newBillDueDate,
      isRecurring: true,
      autoDebit: newBillAutoDebit,
      status: 'pending',
    });

    setNewBillTitle('');
    setNewBillAmount('');
    setIsAddBillOpen(false);
  };

  const handleCreateCard = (e: React.FormEvent) => {
    e.preventDefault();
    const limit = parseFloat(newCardLimit.replace(/\./g, '').replace(',', '.'));
    if (!newCardName.trim() || !newCardBank.trim() || isNaN(limit)) return;

    addCard({
      name: newCardName.trim(),
      bank: newCardBank.trim(),
      lastDigits: newCardDigits.slice(-4) || '0000',
      closingDay: Number(newCardClosing),
      dueDay: Number(newCardDue),
      creditLimit: limit,
      ownerMemberId: newCardOwner,
      color: newCardColor,
    });

    setNewCardName('');
    setNewCardBank('');
    setNewCardDigits('');
    setIsAddCardOpen(false);
  };

  const selectedDayEvents = selectedDay ? eventsByDay[selectedDay] : null;

  return (
    <div className="space-y-6">
      
      {/* Encabezado con Botones de Acción */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-blue-600" />
            <span>Vencimientos de Cuentas & Tarjetas de Crédito</span>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Supervisa las fechas de cierre bancario, resúmenes e impuestos con semáforo preventivo.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsAddCardOpen(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
          >
            <CreditCard className="w-4 h-4 text-slate-600" />
            <span>+ Agregar Tarjeta</span>
          </button>
          <button
            onClick={() => setIsAddBillOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-all shadow-sm shadow-blue-500/20 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>+ Nuevo Vencimiento</span>
          </button>
        </div>
      </div>

      {/* Tarjetas de Crédito de la Familia (Visual Showcase) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">
            Tarjetas Registradas y Límites
          </h2>
          <span className="text-xs text-slate-500">{cards.length} tarjetas activas</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {cards.map((card) => {
            const owner = members.find((m) => m.id === card.ownerMemberId);
            return (
              <div
                key={card.id}
                className="relative overflow-hidden rounded-2xl p-5 text-white shadow-md transition-all hover:scale-[1.01]"
                style={{
                  background: `linear-gradient(135deg, ${card.color || '#1E293B'} 0%, #0F172A 100%)`,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono tracking-widest uppercase opacity-80">
                    {card.bank}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold">{card.name}</span>
                    <button
                      onClick={() => deleteCard(card.id)}
                      className="text-white/60 hover:text-white p-1 rounded-md transition-colors"
                      title="Eliminar tarjeta"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="my-4 font-mono text-lg tracking-widest">
                  •••• •••• •••• {card.lastDigits}
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/10 text-xs">
                  <div>
                    <span className="text-white/60 text-[10px] block">Cierre</span>
                    <span className="font-bold">Día {card.closingDay}</span>
                  </div>
                  <div>
                    <span className="text-white/60 text-[10px] block">Vencimiento</span>
                    <span className="font-bold text-amber-300">Día {card.dueDay}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-white/60 text-[10px] block">Límite</span>
                    <span className="font-bold font-mono">
                      {formatCurrency(card.creditLimit)}
                    </span>
                  </div>
                </div>

                <div className="mt-2 text-[11px] text-white/70 flex items-center justify-between">
                  <span>Titular: {owner?.name || 'Familiar'}</span>
                  <span className="bg-white/20 px-2 py-0.5 rounded text-[10px]">Al día</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Calendario Mensual Interactivo & Selector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Cuadrícula del Calendario (2 columnas) */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-slate-900 capitalize">
                {monthName}
              </span>
              <span className="text-xs text-slate-500 font-medium">
                · Haz clic en un día para ver detalles
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={prevMonth}
                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={nextMonth}
                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Días de la semana */}
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-400">
            {daysOfWeek.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Celdas del Calendario */}
          <div className="grid grid-cols-7 gap-1.5">
            {/* Espacios vacíos antes del primer día del mes */}
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} className="h-20 bg-slate-50/50 rounded-xl border border-slate-100/60" />
            ))}

            {/* Días del mes */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const isToday =
                now.getDate() === day && now.getMonth() === month && now.getFullYear() === year;
              const isSelected = selectedDay === day;
              const events = eventsByDay[day] || { bills: [], cardClosings: [], cardDues: [] };

              const hasPendingBill = events.bills.some((b) => b.status === 'pending');
              const hasCardDue = events.cardDues.length > 0;
              const hasCardClosing = events.cardClosings.length > 0;

              return (
                <button
                  key={`day-${day}`}
                  onClick={() => setSelectedDay(day)}
                  className={`h-20 p-1.5 rounded-xl border text-left transition-all flex flex-col justify-between relative cursor-pointer ${
                    isSelected
                      ? 'border-blue-600 bg-blue-50/60 ring-2 ring-blue-600/20'
                      : isToday
                      ? 'border-blue-300 bg-blue-50/30'
                      : 'border-slate-200/80 hover:border-slate-300 hover:bg-slate-50/70'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-bold ${
                        isToday
                          ? 'w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center'
                          : 'text-slate-800'
                      }`}
                    >
                      {day}
                    </span>
                    {hasPendingBill && (
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" title="Factura por vencer" />
                    )}
                  </div>

                  {/* Indicadores de eventos en el día */}
                  <div className="space-y-0.5 overflow-hidden">
                    {events.bills.slice(0, 1).map((b) => (
                      <div
                        key={b.id}
                        className={`text-[9px] truncate px-1 py-0.5 rounded font-medium ${
                          b.status === 'paid'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {b.title}
                      </div>
                    ))}
                    {hasCardDue && (
                      <div className="text-[9px] truncate px-1 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">
                        Vence {events.cardDues[0].name}
                      </div>
                    )}
                    {hasCardClosing && !hasCardDue && events.bills.length === 0 && (
                      <div className="text-[9px] truncate px-1 py-0.5 rounded bg-slate-100 text-slate-700 font-medium">
                        Cierre {events.cardClosings[0].name}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Leyenda del Semáforo */}
          <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-slate-100 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span>Vencimiento Inminente / Pendiente</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <span>Vencimiento de Resumen de Tarjeta</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              <span>Factura Pagada / Al día</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-400" />
              <span>Fecha de Cierre de Tarjeta</span>
            </span>
          </div>

        </div>

        {/* Panel Lateral: Detalle del Día o Lista de Cuentas */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">
              {selectedDay
                ? `Eventos del Día ${selectedDay} de ${monthName}`
                : 'Todas las Cuentas del Mes'}
            </h3>
            {selectedDay && (
              <button
                onClick={() => setSelectedDay(null)}
                className="text-xs text-blue-600 hover:underline font-semibold"
              >
                Ver todas
              </button>
            )}
          </div>

          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
            {/* Si hay día seleccionado */}
            {selectedDay ? (
              selectedDayEvents && (
                <>
                  {selectedDayEvents.bills.length === 0 &&
                    selectedDayEvents.cardDues.length === 0 &&
                    selectedDayEvents.cardClosings.length === 0 && (
                      <p className="text-xs text-slate-400 py-6 text-center">
                        No hay compromisos ni vencimientos registrados para este día.
                      </p>
                    )}

                  {selectedDayEvents.bills.map((bill) => (
                    <div
                      key={bill.id}
                      className="p-3 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-900">{bill.title}</span>
                        <span className="text-xs font-mono font-bold text-slate-900">
                          {formatCurrency(bill.amount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-500">{bill.serviceCategory}</span>
                        <button
                          onClick={() => toggleBillPaid(bill.id)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${
                            bill.status === 'paid'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-red-100 text-red-800 hover:bg-emerald-100 hover:text-emerald-800'
                          }`}
                        >
                          {bill.status === 'paid' ? '✓ Pagado' : 'Marcar Pagado'}
                        </button>
                      </div>
                    </div>
                  ))}

                  {selectedDayEvents.cardDues.map((card) => (
                    <div
                      key={`card-due-${card.id}`}
                      className="p-3 rounded-xl border border-amber-200 bg-amber-50/50 space-y-1"
                    >
                      <p className="text-xs font-bold text-amber-900">
                        💳 Vencimiento de Resumen: {card.name} ({card.bank})
                      </p>
                      <p className="text-[11px] text-amber-700">
                        Paga antes de las 18:00 hs para evitar intereses punitorios.
                      </p>
                    </div>
                  ))}

                  {selectedDayEvents.cardClosings.map((card) => (
                    <div
                      key={`card-close-${card.id}`}
                      className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1"
                    >
                      <p className="text-xs font-bold text-slate-800">
                        🔒 Cierre de Tarjeta: {card.name} ({card.bank})
                      </p>
                      <p className="text-[11px] text-slate-600">
                        Las compras a partir de mañana ingresan en el resumen del próximo mes.
                      </p>
                    </div>
                  ))}
                </>
              )
            ) : (
              /* Lista General de Facturas */
              bills.map((bill) => (
                <div
                  key={bill.id}
                  className="p-3.5 rounded-xl border border-slate-200/90 bg-slate-50/50 hover:bg-white transition-all space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold text-slate-900">{bill.title}</p>
                      <p className="text-[11px] text-slate-500">
                        Vence: {bill.dueDate}{' '}
                        {bill.autoDebit && <span className="text-blue-600">· Débito auto</span>}
                      </p>
                    </div>
                    <span className="text-sm font-mono font-bold text-slate-900">
                      {formatCurrency(bill.amount)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                    <button
                      onClick={() => toggleBillPaid(bill.id)}
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded transition-colors flex items-center gap-1 ${
                        bill.status === 'paid'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-red-50 text-red-700 hover:bg-emerald-50 hover:text-emerald-700'
                      }`}
                    >
                      {bill.status === 'paid' ? (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          <span>Pagada</span>
                        </>
                      ) : (
                        <>
                          <Clock className="w-3 h-3 text-red-500" />
                          <span>Pendiente de pago</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => deleteBill(bill.id)}
                      className="text-slate-400 hover:text-red-600 p-1 rounded transition-colors"
                      title="Eliminar factura"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* Modal Agregar Nueva Cuenta / Vencimiento */}
      {isAddBillOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Registrar Nueva Cuenta o Servicio
            </h3>
            <form onSubmit={handleCreateBill} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nombre del Servicio o Cuenta *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Internet Claro, Edenor, Seguro Hogar"
                  value={newBillTitle}
                  onChange={(e) => setNewBillTitle(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Categoría
                </label>
                <select
                  value={newBillCategory}
                  onChange={(e) => setNewBillCategory(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl bg-white"
                >
                  <option value="Servicios Básicos">Servicios Básicos (Luz, Gas, Agua)</option>
                  <option value="Conectividad">Conectividad & Telefonía</option>
                  <option value="Vivienda">Vivienda & Expensas</option>
                  <option value="Educación">Educación & Colegios</option>
                  <option value="Seguros">Seguros & Salud</option>
                  <option value="Suscripciones">Suscripciones (Streaming, Software)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monto Estimado o de Factura ($ ARS) *
                </label>
                <input
                  type="number"
                  required
                  placeholder="0"
                  value={newBillAmount}
                  onChange={(e) => setNewBillAmount(e.target.value)}
                  className="w-full text-sm font-mono px-3 py-2 border border-slate-300 rounded-xl outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Fecha de Vencimiento *
                </label>
                <input
                  type="date"
                  required
                  value={newBillDueDate}
                  onChange={(e) => setNewBillDueDate(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl outline-none"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={newBillAutoDebit}
                    onChange={(e) => setNewBillAutoDebit(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded"
                  />
                  <span className="text-xs font-semibold text-slate-700">
                    Está adherida a Débito Automático
                  </span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddBillOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl"
                >
                  Guardar Vencimiento
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Agregar Nueva Tarjeta */}
      {isAddCardOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Registrar Nueva Tarjeta Familiar
            </h3>
            <form onSubmit={handleCreateCard} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nombre de la Tarjeta *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Visa Signature, Mastercard Black"
                  value={newCardName}
                  onChange={(e) => setNewCardName(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Banco Emisor *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Santander, Galicia, BBVA, Macro"
                  value={newCardBank}
                  onChange={(e) => setNewCardBank(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Últimos 4 Dígitos
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    placeholder="1234"
                    value={newCardDigits}
                    onChange={(e) => setNewCardDigits(e.target.value)}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-300 rounded-xl outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Límite ($ ARS)
                  </label>
                  <input
                    type="number"
                    placeholder="1500000"
                    value={newCardLimit}
                    onChange={(e) => setNewCardLimit(e.target.value)}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-300 rounded-xl outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Día de Cierre (Mes) *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    required
                    value={newCardClosing}
                    onChange={(e) => setNewCardClosing(parseInt(e.target.value, 10))}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-300 rounded-xl outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Día de Vencimiento *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    required
                    value={newCardDue}
                    onChange={(e) => setNewCardDue(parseInt(e.target.value, 10))}
                    className="w-full text-sm font-mono px-3 py-2 border border-slate-300 rounded-xl outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Titular Familiar
                </label>
                <select
                  value={newCardOwner}
                  onChange={(e) => setNewCardOwner(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl bg-white"
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddCardOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl"
                >
                  Guardar Tarjeta
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
