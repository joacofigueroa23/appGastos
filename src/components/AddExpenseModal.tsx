import React, { useState } from 'react';
import { useFinance } from '../context/FinanceContext';
import { ExpenseCategory, PaymentMethod } from '../types';
import {
  X,
  Sparkles,
  Receipt,
  CreditCard as CardIcon,
  Check,
  Loader2,
  Calendar,
} from 'lucide-react';

interface AddExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORIES: ExpenseCategory[] = [
  'Supermercado',
  'Alimentación & Salidas',
  'Servicios & Hogar',
  'Transporte & Combustible',
  'Salud & Farmacia',
  'Educación',
  'Ocio & Entretenimiento',
  'Ropa & Cuidado Personal',
  'Tecnología & Equipamiento',
  'Mascotas',
  'Impuestos & Seguros',
  'Otros',
];

const PAYMENT_METHODS: PaymentMethod[] = [
  'Tarjeta de Crédito',
  'Tarjeta de Débito',
  'Efectivo',
  'Transferencia',
  'Billetera Virtual',
];

export const AddExpenseModal: React.FC<AddExpenseModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { members, cards, activeMemberId, addExpense } = useFinance();

  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [aiText, setAiText] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<string | null>(null);

  // Formulario manual
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [category, setCategory] = useState<ExpenseCategory>('Supermercado');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Tarjeta de Débito');
  const [cardId, setCardId] = useState<string>(cards[0]?.id || '');
  const [paidByMemberId, setPaidByMemberId] = useState<string>(activeMemberId);
  const [isShared, setIsShared] = useState<boolean>(true);
  const [installmentTotal, setInstallmentTotal] = useState<number>(1);
  const [installmentCurrent, setInstallmentCurrent] = useState<number>(1);
  const [date, setDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [notes, setNotes] = useState('');

  if (!isOpen) return null;

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(amount.replace(/\./g, '').replace(',', '.'));
    if (!description.trim() || isNaN(numAmount) || numAmount <= 0) return;

    addExpense({
      description: description.trim(),
      amount: numAmount,
      currency: 'ARS',
      category,
      date,
      paymentMethod,
      cardId: paymentMethod === 'Tarjeta de Crédito' ? cardId : undefined,
      paidByMemberId,
      isShared,
      installmentTotal: paymentMethod === 'Tarjeta de Crédito' ? installmentTotal : 1,
      installmentCurrent: paymentMethod === 'Tarjeta de Crédito' ? installmentCurrent : 1,
      notes: notes.trim() || undefined,
      source: 'manual',
    });

    handleClose();
  };

  const handleAiParse = async () => {
    if (!aiText.trim()) return;
    setIsAiLoading(true);
    setAiFeedback(null);

    try {
      const activeMember = members.find((m) => m.id === paidByMemberId);
      const res = await fetch('/api/gemini/parse-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: aiText,
          memberName: activeMember?.name,
          knownCards: cards.map((c) => `${c.name} (${c.bank})`),
        }),
      });

      const data = await res.json();
      if (data.success && data.data) {
        const item = data.data;
        setDescription(item.description || aiText.slice(0, 40));
        setAmount(String(item.amount || ''));
        if (item.category && CATEGORIES.includes(item.category)) {
          setCategory(item.category);
        }
        if (item.paymentMethod && PAYMENT_METHODS.includes(item.paymentMethod)) {
          setPaymentMethod(item.paymentMethod);
        }
        if (item.isShared !== undefined) {
          setIsShared(item.isShared);
        }
        if (item.installmentTotal) {
          setInstallmentTotal(item.installmentTotal);
        }
        setAiFeedback(item.replyText || '¡Interpretado con éxito! Revisa los campos y confirma.');
        setMode('manual');
      } else {
        setAiFeedback('No se pudo extraer la información automáticamente. Por favor completa los campos.');
      }
    } catch (e) {
      console.error(e);
      setAiFeedback('Error al consultar el motor de inteligencia artificial.');
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleClose = () => {
    setDescription('');
    setAmount('');
    setAiText('');
    setAiFeedback(null);
    setNotes('');
    setInstallmentTotal(1);
    setInstallmentCurrent(1);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full overflow-hidden transition-all">
        
        {/* Cabecera */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Registrar Nuevo Gasto</h3>
              <p className="text-xs text-slate-500">Agrega movimientos familiares o personales</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Selector de Modo: Manual o AI Rápido */}
        <div className="px-6 pt-4">
          <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-xl gap-1">
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'manual'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Carga Manual Detallada
            </button>
            <button
              type="button"
              onClick={() => setMode('ai')}
              className={`flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'ai'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Autocompletar con IA</span>
            </button>
          </div>
        </div>

        {/* Modo AI */}
        {mode === 'ai' ? (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Escribe como si lo mandaras por WhatsApp:
              </label>
              <textarea
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder="Ejemplo: Gasté $45.000 en el súper Carrefour con Visa en 3 cuotas"
                rows={3}
                className="w-full text-sm p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  'Supermercado Coto $34.000 en 1 pago Visa',
                  'Nafta YPF $28.000 débito',
                  'Farmacity $12.500 efectivo personal',
                ].map((sample, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setAiText(sample)}
                    className="text-[11px] bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 px-2 py-1 rounded-md transition-colors text-left"
                  >
                    + {sample}
                  </button>
                ))}
              </div>
            </div>

            {aiFeedback && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-800">
                {aiFeedback}
              </div>
            )}

            <button
              type="button"
              onClick={handleAiParse}
              disabled={isAiLoading || !aiText.trim()}
              className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              {isAiLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Procesando mensaje con Gemini 3.8 Flash...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Completar Formulario con IA</span>
                </>
              )}
            </button>
          </div>
        ) : (
          /* Formulario Manual */
          <form onSubmit={handleManualSubmit} className="p-6 space-y-4">
            
            {aiFeedback && (
              <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{aiFeedback}</span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Descripción */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Descripción del Gasto *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ej. Supermercado Coto, Nafta, Factura Luz"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              {/* Monto */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monto Total ($ ARS) *
                </label>
                <input
                  type="number"
                  step="any"
                  required
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full text-sm font-mono tabular-nums px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              {/* Fecha */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Fecha *
                </label>
                <div className="relative">
                  <input
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                  <Calendar className="w-4 h-4 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
                </div>
              </div>

              {/* Categoría */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Categoría *
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Miembro que pagó */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Pagado por *
                </label>
                <select
                  value={paidByMemberId}
                  onChange={(e) => setPaidByMemberId(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.avatar} {m.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Método de Pago */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Medio de Pago *
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                >
                  {PAYMENT_METHODS.map((pm) => (
                    <option key={pm} value={pm}>
                      {pm}
                    </option>
                  ))}
                </select>
              </div>

              {/* Tarjeta vinculada (si es crédito) */}
              {paymentMethod === 'Tarjeta de Crédito' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tarjeta de Crédito
                  </label>
                  <select
                    value={cardId}
                    onChange={(e) => setCardId(e.target.value)}
                    className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white"
                  >
                    {cards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.bank} ·····{c.lastDigits})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Cuotas (si es crédito) */}
              {paymentMethod === 'Tarjeta de Crédito' && (
                <div className="sm:col-span-2 grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Total de Cuotas
                    </label>
                    <select
                      value={installmentTotal}
                      onChange={(e) => setInstallmentTotal(parseInt(e.target.value, 10))}
                      className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded-lg bg-white"
                    >
                      {[1, 2, 3, 6, 9, 12, 18, 24].map((n) => (
                        <option key={n} value={n}>
                          {n === 1 ? '1 pago (Sin cuotas)' : `${n} cuotas fijas`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {installmentTotal > 1 && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Cuota Actual que se Paga
                      </label>
                      <input
                        type="number"
                        min="1"
                        max={installmentTotal}
                        value={installmentCurrent}
                        onChange={(e) => setInstallmentCurrent(parseInt(e.target.value, 10) || 1)}
                        className="w-full text-sm px-3 py-1.5 border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
                      />
                    </div>
                  )}

                  {installmentTotal > 1 && amount && (
                    <div className="col-span-2 text-xs text-slate-600 pt-1 font-mono">
                      Monto aproximado por cuota:{' '}
                      <strong className="text-slate-900">
                        ${(parseFloat(amount) / installmentTotal).toLocaleString('es-AR', { maximumFractionDigits: 0 })}
                      </strong>
                    </div>
                  )}
                </div>
              )}

              {/* Destino del gasto: Común o Personal */}
              <div className="sm:col-span-2 pt-1">
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isShared}
                    onChange={(e) => setIsShared(e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                  />
                  <span className="text-xs font-semibold text-slate-800">
                    Gasto Común del Hogar (se divide en el balance familiar)
                  </span>
                </label>
                <p className="text-[11px] text-slate-500 ml-6.5 mt-0.5">
                  {isShared
                    ? 'Se contabiliza para el presupuesto general de la familia.'
                    : 'Gasto individual propio de quien lo pagó (no se reclama compensación).'}
                </p>
              </div>

              {/* Notas opcionales */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Notas o Detalle (Opcional)
                </label>
                <input
                  type="text"
                  placeholder="Ej. Ticket guardado, garantía de 1 año"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full text-sm px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

            </div>

            {/* Acciones */}
            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-all shadow-sm shadow-blue-500/20 cursor-pointer"
              >
                Guardar Gasto
              </button>
            </div>

          </form>
        )}

      </div>
    </div>
  );
};
