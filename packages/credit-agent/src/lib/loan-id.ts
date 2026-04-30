// Loan ID minting. Uses a Mongo countDocuments() + 1 strategy.
// TODO: race-prone under concurrent /credit/fund. Replace with a Mongo
// counters collection + atomic findOneAndUpdate($inc) before live demo.

import { LoanModel } from "@credit/shared";

export async function mintLoanId(): Promise<string> {
  const count = await LoanModel.countDocuments();
  const seq = count + 1;
  return `L_${seq.toString().padStart(4, "0")}`;
}
