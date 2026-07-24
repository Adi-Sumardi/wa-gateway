import * as crypto from 'crypto';

const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SNAP_BASE_URL = isProduction
  ? 'https://app.midtrans.com/snap/v1/transactions'
  : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

const getServerKey = () => {
  const key = process.env.MIDTRANS_SERVER_KEY;
  if (!key) throw new Error('MIDTRANS_SERVER_KEY is not configured');
  return key;
};

export const createSnapTransaction = async (params: {
  orderId: string;
  grossAmount: number;
  customerName: string;
  customerEmail: string;
}): Promise<{ token: string; redirect_url: string }> => {
  const auth = Buffer.from(`${getServerKey()}:`).toString('base64');

  const response = await fetch(SNAP_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      transaction_details: {
        order_id: params.orderId,
        gross_amount: params.grossAmount,
      },
      customer_details: {
        first_name: params.customerName,
        email: params.customerEmail,
      },
    }),
  });

  const data = (await response.json()) as any;
  if (!response.ok || !data.token) {
    throw new Error(data.error_messages?.join(', ') || 'Failed to create Midtrans transaction');
  }

  return { token: data.token, redirect_url: data.redirect_url };
};

export const verifySignature = (params: {
  orderId: string;
  statusCode: string;
  grossAmount: string;
  signatureKey: string;
}): boolean => {
  const expected = crypto
    .createHash('sha512')
    .update(params.orderId + params.statusCode + params.grossAmount + getServerKey())
    .digest('hex');
  return expected === params.signatureKey;
};
