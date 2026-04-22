import { Construct } from "constructs";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";

export interface BudgetProps {
  envName: "dev" | "stage" | "prod";
  monthlyLimitUsd: number;
  notifyEmail: string;
}

export class Budget extends Construct {
  constructor(scope: Construct, id: string, props: BudgetProps) {
    super(scope, id);

    new CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `aquascape-studio-${props.envName}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyLimitUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [
          { subscriptionType: "EMAIL", address: props.notifyEmail },
        ],
      })),
    });
  }
}
