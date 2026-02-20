import { useState, useCallback, useMemo, useRef } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";
import * as _ from "lodash";

const STEPS = ["Import", "Clean", "Summary", "Variables", "Analysis", "R Code"];
const VAR_TYPES = ["Continuous", "Binary", "Ordinal", "Nominal", "Count", "Text", "Date"];
const VAR_CLR = { Continuous: "#63b3ed", Binary: "#f6ad55", Ordinal: "#fc8181", Nominal: "#68d391", Count: "#d69e2e", Text: "#b794f4", Date: "#f687b3" };
const ANY = ["Continuous", "Binary", "Ordinal", "Nominal", "Count"];

function inferType(vals) {
  const s = vals.filter(v => v != null && v !== "" && v !== "NA").slice(0, 80);
  if (!s.length) return "Text";
  const u = new Set(s.map(String));
  if (s.every(v => ["0","1","true","false","yes","no","True","False","Yes","No"].includes(String(v).trim()))) return "Binary";
  if (s.every(v => !isNaN(Number(v)))) {
    if (u.size <= 2) return "Binary";
    if (u.size <= 7 && s.every(v => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 10)) return "Ordinal";
    if (s.every(v => Number.isInteger(Number(v)) && Number(v) >= 0)) return "Count";
    return "Continuous";
  }
  if (s.every(v => !isNaN(Date.parse(v)) && String(v).length > 6)) return "Date";
  if (u.size <= 15) return "Nominal";
  return "Text";
}

function cln(n) { return n.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/^(\d)/, "x$1") || "col"; }

function buildCatalog() {
  return [
    { family: "Descriptive", methods: [
      { id: "desc", name: "Descriptive Statistics", desc: "Mean, SD, median, range", pkgs: ["skimr", "psych"],
        needs: [{ role: "Variables", types: ["Continuous", "Ordinal", "Count"], min: 1, max: 20 }],
        assumptions: [],
        gen: v => ({
          code: `library(skimr); library(psych)\ndf %>% select(${v.Variables.join(", ")}) %>% skim()\ndf %>% select(${v.Variables.join(", ")}) %>% describe()`,
          viz: `library(ggplot2)\n${v.Variables.map(x => `ggplot(df, aes(x=${x})) + geom_histogram(fill="#3182ce", bins=30) + theme_minimal() + labs(title="${x}")`).join("\n")}`
        })
      },
      { id: "freq", name: "Frequency Tables", desc: "Counts & percentages for categories", pkgs: ["janitor"],
        needs: [{ role: "Variables", types: ["Nominal", "Binary", "Ordinal"], min: 1, max: 10 }],
        assumptions: [],
        gen: v => ({
          code: `library(janitor)\n${v.Variables.map(x => `df %>% tabyl(${x}) %>% adorn_pct_formatting() %>% adorn_totals("row")`).join("\n")}`,
          viz: `${v.Variables.map(x => `ggplot(df, aes(x=reorder(${x},${x},function(x)-length(x)))) + geom_bar(fill="#3182ce") + coord_flip() + theme_minimal() + labs(title="${x}")`).join("\n")}`
        })
      },
      { id: "xtab", name: "Cross-tabulation + Chi-square", desc: "Two-way table with test", pkgs: ["janitor", "rstatix"],
        needs: [
          { role: "Row Variable", types: ["Nominal", "Binary", "Ordinal"], min: 1, max: 1 },
          { role: "Column Variable", types: ["Nominal", "Binary", "Ordinal"], min: 1, max: 1 }
        ],
        assumptions: ["Expected cell counts >= 5; use Fisher's exact if violated"],
        gen: v => ({
          code: `library(janitor); library(rstatix)\ndf %>% tabyl(${v["Row Variable"][0]}, ${v["Column Variable"][0]}) %>%\n  adorn_totals(c("row","col")) %>% adorn_percentages("row") %>%\n  adorn_pct_formatting() %>% adorn_ns()\nchisq.test(table(df$${v["Row Variable"][0]}, df$${v["Column Variable"][0]}))`,
          viz: `ggplot(df, aes(x=${v["Row Variable"][0]}, fill=${v["Column Variable"][0]})) + geom_bar(position="fill") + scale_y_continuous(labels=scales::percent) + theme_minimal()`
        })
      }
    ]},
    { family: "Correlation", methods: [
      { id: "corr", name: "Correlation Analysis", desc: "Pearson, Spearman, partial", pkgs: ["correlation", "corrplot"],
        needs: [
          { role: "Variables", types: ["Continuous", "Ordinal", "Count"], min: 2, max: 20 },
          { role: "Control For (partial)", types: ["Continuous", "Ordinal"], min: 0, max: 5 }
        ],
        assumptions: ["Pearson: linearity & normality", "Spearman for ordinal/non-normal"],
        gen: v => {
          const p = v["Control For (partial)"]?.length;
          return {
            code: `library(correlation); library(corrplot)\ncor_results <- df %>% select(${v.Variables.join(", ")}) %>% correlation(method="pearson")\nprint(cor_results)${p ? `\n\n# Partial correlations\ndf %>% select(${[...v.Variables, ...v["Control For (partial)"]].join(", ")}) %>%\n  correlation(partial=TRUE, controlling=c(${v["Control For (partial)"].map(x => `"${x}"`).join(",")}))` : ""}`,
            viz: `cor_mat <- df %>% select(${v.Variables.join(", ")}) %>% cor(use="complete.obs")\ncorrplot(cor_mat, method="color", type="upper", addCoef.col="black")`
          };
        }
      }
    ]},
    { family: "Comparison", methods: [
      { id: "ttest", name: "Independent t-test", desc: "Compare 2 group means", pkgs: ["rstatix", "effectsize", "ggpubr"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Grouping Variable", types: ["Binary"], min: 1, max: 1 },
          { role: "Covariates", types: ANY, min: 0, max: 5 }
        ],
        assumptions: ["Normality per group", "Homogeneity of variance", "If violated: Welch's or Mann-Whitney"],
        gen: v => {
          const cov = v.Covariates?.length ? `\n\n# With covariates\nsummary(lm(${v.Outcome[0]} ~ ${v["Grouping Variable"][0]} + ${v.Covariates.join(" + ")}, data=df))` : "";
          return {
            code: `library(rstatix); library(effectsize)\ndf %>% group_by(${v["Grouping Variable"][0]}) %>% get_summary_stats(${v.Outcome[0]}, type="mean_sd")\nt.test(${v.Outcome[0]} ~ ${v["Grouping Variable"][0]}, data=df)\ncohens_d(${v.Outcome[0]} ~ ${v["Grouping Variable"][0]}, data=df)${cov}`,
            viz: `library(ggpubr)\nggboxplot(df, x="${v["Grouping Variable"][0]}", y="${v.Outcome[0]}", color="${v["Grouping Variable"][0]}", add="jitter") + stat_compare_means(method="t.test")`
          };
        }
      },
      { id: "anova", name: "One-way ANOVA", desc: "Compare means across 3+ groups", pkgs: ["rstatix", "emmeans", "effectsize"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Grouping Variable", types: ["Nominal", "Ordinal"], min: 1, max: 1 },
          { role: "Covariates", types: ANY, min: 0, max: 5 }
        ],
        assumptions: ["Normality within groups", "Homogeneity of variance", "If violated: Kruskal-Wallis"],
        gen: v => {
          const cov = v.Covariates?.length ? ` + ${v.Covariates.join(" + ")}` : "";
          return {
            code: `library(rstatix); library(emmeans); library(effectsize)\naov_res <- aov(${v.Outcome[0]} ~ ${v["Grouping Variable"][0]}${cov}, data=df)\nsummary(aov_res)\neta_squared(aov_res)\nemmeans(aov_res, pairwise ~ ${v["Grouping Variable"][0]}, adjust="tukey")`,
            viz: `ggplot(df, aes(x=${v["Grouping Variable"][0]}, y=${v.Outcome[0]}, fill=${v["Grouping Variable"][0]})) + geom_boxplot(alpha=0.7) + geom_jitter(alpha=0.3, width=0.1) + theme_minimal()`
          };
        }
      },
      { id: "ancova", name: "ANCOVA", desc: "ANOVA controlling for covariates", pkgs: ["car", "emmeans", "effectsize"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Grouping Variable", types: ["Nominal", "Binary"], min: 1, max: 1 },
          { role: "Covariates", types: ["Continuous", "Ordinal", "Count"], min: 1, max: 10 }
        ],
        assumptions: ["Normality of residuals", "Homogeneity of variance", "Homogeneity of regression slopes", "Covariate measured before treatment"],
        gen: v => ({
          code: `library(car); library(emmeans); library(effectsize)\nmodel <- lm(${v.Outcome[0]} ~ ${v["Grouping Variable"][0]} + ${v.Covariates.join(" + ")}, data=df)\nAnova(model, type=3)\neta_squared(model, partial=TRUE)\nemmeans(model, pairwise ~ ${v["Grouping Variable"][0]}, adjust="bonferroni")`,
          viz: `library(ggeffects)\nplot(ggpredict(model, terms="${v["Grouping Variable"][0]}")) + theme_minimal() + labs(title="Adjusted Means")`
        })
      },
      { id: "manova", name: "MANOVA / MANCOVA", desc: "Multiple outcomes across groups", pkgs: ["car", "effectsize", "heplots"],
        needs: [
          { role: "Outcomes", types: ["Continuous"], min: 2, max: 10 },
          { role: "Grouping Variable", types: ["Nominal", "Binary"], min: 1, max: 1 },
          { role: "Covariates (MANCOVA)", types: ["Continuous", "Count"], min: 0, max: 10 }
        ],
        assumptions: ["Multivariate normality", "Homogeneity of covariance (Box's M)", "No multicollinearity among DVs", "N per group > number of DVs"],
        gen: v => {
          const cov = v["Covariates (MANCOVA)"]?.length ? ` + ${v["Covariates (MANCOVA)"].join(" + ")}` : "";
          return {
            code: `library(car); library(effectsize)\noutcomes <- cbind(${v.Outcomes.map(o => `df$${o}`).join(", ")})\nmodel <- lm(outcomes ~ ${v["Grouping Variable"][0]}${cov}, data=df)\nManova(model, type=3) %>% summary()`,
            viz: `library(heplots)\nheplot(model, fill=TRUE)`
          };
        }
      },
      { id: "fact_anova", name: "Factorial ANOVA (Two-way)", desc: "Two factors + interaction", pkgs: ["car", "emmeans", "effectsize"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Factor A", types: ["Nominal", "Binary", "Ordinal"], min: 1, max: 1 },
          { role: "Factor B", types: ["Nominal", "Binary", "Ordinal"], min: 1, max: 1 },
          { role: "Covariates", types: ANY, min: 0, max: 5 }
        ],
        assumptions: ["Normality of residuals", "Homogeneity of variance", "Balanced design preferred"],
        gen: v => {
          const cov = v.Covariates?.length ? ` + ${v.Covariates.join(" + ")}` : "";
          return {
            code: `library(car); library(emmeans); library(effectsize)\nmodel <- lm(${v.Outcome[0]} ~ ${v["Factor A"][0]} * ${v["Factor B"][0]}${cov}, data=df)\nAnova(model, type=3)\neta_squared(model, partial=TRUE)\nemmeans(model, pairwise ~ ${v["Factor A"][0]} | ${v["Factor B"][0]}, adjust="bonferroni")`,
            viz: `emmip(model, ${v["Factor B"][0]} ~ ${v["Factor A"][0]}, CIs=TRUE) + theme_minimal() + labs(title="Interaction Plot")`
          };
        }
      }
    ]},
    { family: "Regression", methods: [
      { id: "ols", name: "Linear Regression (OLS)", desc: "Predict continuous outcome", pkgs: ["performance", "report", "effectsize"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Predictors", types: ANY, min: 1, max: 15 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 },
          { role: "Interaction (select 2)", types: ANY, min: 0, max: 2 }
        ],
        assumptions: ["Linearity", "Normal residuals", "Homoscedasticity", "VIF < 5", "Independence"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          const inter = v["Interaction (select 2)"]?.length === 2 ? ` + ${v["Interaction (select 2)"][0]}:${v["Interaction (select 2)"][1]}` : "";
          return {
            code: `library(performance); library(report)\nmodel <- lm(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}${inter}, data=df)\nsummary(model); confint(model)\nmodel_performance(model)\nreport(model)\n\n# Diagnostics\ncheck_model(model)\ncheck_normality(model)\ncheck_heteroscedasticity(model)\ncheck_collinearity(model)`,
            viz: `library(see)\nplot(parameters::parameters(model)) + theme_minimal()\ncheck_model(model)`
          };
        }
      },
      { id: "logit", name: "Logistic Regression", desc: "Predict binary outcome", pkgs: ["performance", "report"],
        needs: [
          { role: "Outcome", types: ["Binary"], min: 1, max: 1 },
          { role: "Predictors", types: ANY, min: 1, max: 15 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Binary outcome", "No multicollinearity", "Linearity of log-odds"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          return {
            code: `library(performance); library(report)\nmodel <- glm(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}, data=df, family=binomial)\nsummary(model)\nexp(cbind(OR=coef(model), confint(model)))\nreport(model)`,
            viz: `library(ggeffects)\nplot(ggpredict(model, terms="${v.Predictors[0]}")) + theme_minimal()`
          };
        }
      },
      { id: "ordinal", name: "Ordinal Regression", desc: "Predict ordered outcome", pkgs: ["MASS", "brant"],
        needs: [
          { role: "Outcome", types: ["Ordinal"], min: 1, max: 1 },
          { role: "Predictors", types: ANY, min: 1, max: 10 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Proportional odds (Brant test)", "No multicollinearity"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          return {
            code: `library(MASS)\ndf$${v.Outcome[0]} <- factor(df$${v.Outcome[0]}, ordered=TRUE)\nmodel <- polr(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}, data=df, Hess=TRUE)\nsummary(model)\nexp(coef(model))\n\nlibrary(brant)\nbrant(model)`,
            viz: `library(ggeffects)\nplot(ggpredict(model, terms="${v.Predictors[0]}")) + theme_minimal()`
          };
        }
      },
      { id: "poisson", name: "Poisson / Neg Binomial", desc: "Count data models", pkgs: ["MASS", "performance"],
        needs: [
          { role: "Outcome", types: ["Count"], min: 1, max: 1 },
          { role: "Predictors", types: ANY, min: 1, max: 10 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 },
          { role: "Offset (exposure)", types: ["Continuous", "Count"], min: 0, max: 1 }
        ],
        assumptions: ["Mean ~ variance for Poisson", "If overdispersed: Neg Binomial"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          const off = v["Offset (exposure)"]?.length ? `, offset=log(${v["Offset (exposure)"][0]})` : "";
          return {
            code: `library(MASS); library(performance)\nmodel_p <- glm(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}, data=df, family=poisson${off})\nsummary(model_p)\ncheck_overdispersion(model_p)\n\n# If overdispersed:\nmodel_nb <- glm.nb(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}, data=df)\nsummary(model_nb)`,
            viz: `exp(cbind(IRR=coef(model_p), confint(model_p)))`
          };
        }
      }
    ]},
    { family: "Causal Inference", methods: [
      { id: "did", name: "Difference-in-Differences", desc: "Pre/post + treatment/control", pkgs: ["fixest"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Count"], min: 1, max: 1 },
          { role: "Treatment", types: ["Binary"], min: 1, max: 1 },
          { role: "Time Period", types: ["Binary"], min: 1, max: 1 },
          { role: "Controls", types: ANY, min: 0, max: 10 },
          { role: "Cluster Variable", types: ["Nominal"], min: 0, max: 1 }
        ],
        assumptions: ["Parallel trends", "No anticipation", "Stable composition"],
        gen: v => {
          const ctrl = v.Controls?.length ? ` + ${v.Controls.join(" + ")}` : "";
          const cl = v["Cluster Variable"]?.length ? `, cluster=~${v["Cluster Variable"][0]}` : "";
          return {
            code: `library(fixest)\nmodel <- feols(${v.Outcome[0]} ~ ${v.Treatment[0]} * ${v["Time Period"][0]}${ctrl}${cl}, data=df)\nsummary(model)`,
            viz: `df %>% group_by(${v.Treatment[0]}, ${v["Time Period"][0]}) %>%\n  summarise(m=mean(${v.Outcome[0]}, na.rm=TRUE)) %>%\n  ggplot(aes(x=${v["Time Period"][0]}, y=m, color=${v.Treatment[0]}, group=${v.Treatment[0]})) +\n  geom_point(size=3) + geom_line() + theme_minimal() + labs(title="DiD")`
          };
        }
      },
      { id: "psm", name: "Propensity Score Matching", desc: "Match on observables", pkgs: ["MatchIt", "cobalt"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Binary", "Count"], min: 1, max: 1 },
          { role: "Treatment", types: ["Binary"], min: 1, max: 1 },
          { role: "Matching Covariates", types: ANY, min: 1, max: 15 },
          { role: "Exact Match On", types: ["Nominal", "Binary"], min: 0, max: 3 }
        ],
        assumptions: ["Selection on observables", "Common support", "No unmeasured confounders"],
        gen: v => {
          const ex = v["Exact Match On"]?.length ? `, exact=c(${v["Exact Match On"].map(x => `"${x}"`).join(",")})` : "";
          return {
            code: `library(MatchIt); library(cobalt)\nm <- matchit(${v.Treatment[0]} ~ ${v["Matching Covariates"].join(" + ")}, data=df, method="nearest"${ex})\nsummary(m); bal.tab(m)\ndf_m <- match.data(m)\nlm(${v.Outcome[0]} ~ ${v.Treatment[0]}, data=df_m, weights=weights)`,
            viz: `love.plot(m, threshold=0.1) + theme_minimal()`
          };
        }
      },
      { id: "iv", name: "Instrumental Variables", desc: "2SLS for endogeneity", pkgs: ["ivreg"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Endogenous Variable", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Instrument(s)", types: ["Continuous", "Binary"], min: 1, max: 3 },
          { role: "Controls", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Instrument relevance (F>10)", "Exclusion restriction", "Exogeneity"],
        gen: v => {
          const c = v.Controls?.length ? ` + ${v.Controls.join(" + ")}` : "";
          return {
            code: `library(ivreg)\nmodel <- ivreg(${v.Outcome[0]} ~ ${v["Endogenous Variable"][0]}${c} | ${v["Instrument(s)"].join(" + ")}${c}, data=df)\nsummary(model, diagnostics=TRUE)`,
            viz: `ggplot(df, aes(x=${v["Instrument(s)"][0]}, y=${v["Endogenous Variable"][0]})) + geom_point(alpha=0.3) + geom_smooth(method="lm") + theme_minimal() + labs(title="First Stage")`
          };
        }
      },
      { id: "rdd", name: "Regression Discontinuity", desc: "Cutoff-based treatment", pkgs: ["rdrobust"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Running Variable", types: ["Continuous"], min: 1, max: 1 },
          { role: "Covariates", types: ANY, min: 0, max: 5 }
        ],
        assumptions: ["No manipulation at cutoff", "Continuity at cutoff"],
        gen: v => ({
          code: `library(rdrobust)\nrd <- rdrobust(y=df$${v.Outcome[0]}, x=df$${v["Running Variable"][0]}, c=0)\nsummary(rd)`,
          viz: `rdplot(y=df$${v.Outcome[0]}, x=df$${v["Running Variable"][0]}, c=0, title="RD Plot")`
        })
      }
    ]},
    { family: "Mediation / Moderation", methods: [
      { id: "med", name: "Mediation Analysis", desc: "Indirect effects via mediator", pkgs: ["mediation"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Treatment / IV", types: ["Binary", "Continuous"], min: 1, max: 1 },
          { role: "Mediator(s)", types: ["Continuous", "Binary"], min: 1, max: 3 },
          { role: "Covariates", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["No unmeasured confounders", "Sequential ignorability"],
        gen: v => {
          const cov = v.Covariates?.length ? ` + ${v.Covariates.join(" + ")}` : "";
          return {
            code: `library(mediation)\nmed_mod <- lm(${v["Mediator(s)"][0]} ~ ${v["Treatment / IV"][0]}${cov}, data=df)\nout_mod <- lm(${v.Outcome[0]} ~ ${v["Treatment / IV"][0]} + ${v["Mediator(s)"].join(" + ")}${cov}, data=df)\nresult <- mediate(med_mod, out_mod, treat="${v["Treatment / IV"][0]}", mediator="${v["Mediator(s)"][0]}", boot=TRUE, sims=1000)\nsummary(result)`,
            viz: `plot(result)`
          };
        }
      },
      { id: "mod", name: "Moderation Analysis", desc: "Effect varies by moderator", pkgs: ["interactions"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Predictor", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Moderator", types: ANY, min: 1, max: 1 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Same as OLS", "Sufficient moderator variance"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          return {
            code: `library(interactions)\nmodel <- lm(${v.Outcome[0]} ~ ${v.Predictor[0]} * ${v.Moderator[0]}${ctrl}, data=df)\nsummary(model)\nsim_slopes(model, pred=${v.Predictor[0]}, modx=${v.Moderator[0]})`,
            viz: `interact_plot(model, pred=${v.Predictor[0]}, modx=${v.Moderator[0]}, interval=TRUE) + theme_minimal()`
          };
        }
      }
    ]},
    { family: "Factor Analysis / SEM", methods: [
      { id: "efa", name: "Exploratory Factor Analysis", desc: "Discover latent structure", pkgs: ["psych"],
        needs: [{ role: "Items", types: ["Continuous", "Ordinal"], min: 3, max: 50 }],
        assumptions: ["KMO > 0.6", "Bartlett's significant", "N > 5 per item"],
        gen: v => ({
          code: `library(psych)\ndf_i <- df %>% select(${v.Items.join(", ")})\nKMO(df_i)\nfa.parallel(df_i, fa="fa")\nefa <- fa(df_i, nfactors=3, rotate="oblimin", fm="ml")\nprint(efa, cut=0.3, sort=TRUE)`,
          viz: `fa.diagram(efa)\nscree(df_i)`
        })
      },
      { id: "cfa", name: "Confirmatory Factor Analysis", desc: "Test hypothesized structure", pkgs: ["lavaan", "semPlot"],
        needs: [{ role: "Items", types: ["Continuous", "Ordinal"], min: 3, max: 50 }],
        assumptions: ["CFI>0.95, TLI>0.95", "RMSEA<0.06, SRMR<0.08"],
        gen: v => ({
          code: `library(lavaan)\ncfa_model <- '\n  Factor1 =~ ${v.Items.slice(0, 3).join(" + ")}\n  # Factor2 =~ item4 + item5\n'\nfit <- cfa(cfa_model, data=df, estimator="MLR")\nsummary(fit, fit.measures=TRUE, standardized=TRUE)`,
          viz: `library(semPlot)\nsemPaths(fit, what="std", layout="tree", edge.label.cex=0.8)`
        })
      },
      { id: "sem", name: "Structural Equation Model", desc: "Full path model", pkgs: ["lavaan", "semPlot"],
        needs: [
          { role: "Endogenous Vars", types: ["Continuous", "Ordinal", "Binary"], min: 1, max: 20 },
          { role: "Exogenous Vars", types: ANY, min: 1, max: 20 },
          { role: "Indicator Items", types: ["Continuous", "Ordinal"], min: 0, max: 30 }
        ],
        assumptions: ["N>200 preferred", "Multivariate normality or MLR", "Good fit indices"],
        gen: v => ({
          code: `library(lavaan)\nsem_model <- '\n  # Measurement model\n  # Latent =~ ${(v["Indicator Items"] || v["Endogenous Vars"]).slice(0, 3).join(" + ")}\n  # Structural paths\n  # ${v["Endogenous Vars"][0]} ~ ${v["Exogenous Vars"].join(" + ")}\n'\nfit <- sem(sem_model, data=df, estimator="MLR")\nsummary(fit, fit.measures=TRUE, standardized=TRUE)`,
          viz: `semPaths(fit, what="std", layout="tree2", sizeMan=8, sizeLat=10)`
        })
      }
    ]},
    { family: "Mixed Models", methods: [
      { id: "lmm", name: "Linear Mixed Model", desc: "Nested/clustered data", pkgs: ["lme4", "lmerTest", "performance"],
        needs: [
          { role: "Outcome", types: ["Continuous"], min: 1, max: 1 },
          { role: "Fixed Effects", types: ANY, min: 1, max: 10 },
          { role: "Random Grouping", types: ["Nominal"], min: 1, max: 2 },
          { role: "Random Slope Var", types: ["Continuous", "Binary"], min: 0, max: 2 },
          { role: "Controls", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Normal residuals", "Homoscedasticity", "Normal random effects", "Independence at top level"],
        gen: v => {
          const ctrl = v.Controls?.length ? ` + ${v.Controls.join(" + ")}` : "";
          const rs = v["Random Slope Var"]?.length ? ` + ${v["Random Slope Var"][0]}` : "";
          return {
            code: `library(lme4); library(lmerTest); library(performance)\nmodel <- lmer(${v.Outcome[0]} ~ ${v["Fixed Effects"].join(" + ")}${ctrl} + (1${rs} | ${v["Random Grouping"][0]}), data=df)\nsummary(model)\nicc(model)\nr2(model)\ncheck_model(model)`,
            viz: `library(see)\nplot(parameters::parameters(model)) + theme_minimal()\nlibrary(lattice); dotplot(ranef(model))`
          };
        }
      },
      { id: "glmm", name: "Generalized LMM", desc: "Mixed model for binary/count", pkgs: ["lme4"],
        needs: [
          { role: "Outcome", types: ["Binary", "Count"], min: 1, max: 1 },
          { role: "Fixed Effects", types: ANY, min: 1, max: 10 },
          { role: "Random Grouping", types: ["Nominal"], min: 1, max: 2 },
          { role: "Controls", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Correct family", "Normal random effects", "No complete separation"],
        gen: v => {
          const ctrl = v.Controls?.length ? ` + ${v.Controls.join(" + ")}` : "";
          return {
            code: `library(lme4)\nmodel <- glmer(${v.Outcome[0]} ~ ${v["Fixed Effects"].join(" + ")}${ctrl} + (1 | ${v["Random Grouping"][0]}), data=df, family=binomial)\nsummary(model)\nexp(fixef(model))`,
            viz: `library(ggeffects)\nplot(ggpredict(model, terms="${v["Fixed Effects"][0]}")) + theme_minimal()`
          };
        }
      }
    ]},
    { family: "Multiverse", methods: [
      { id: "multi", name: "Multiverse Analysis", desc: "Robustness across choices", pkgs: ["specr", "multiverseRCT"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Treatment", types: ["Binary"], min: 1, max: 1 },
          { role: "Covariates to vary", types: ANY, min: 1, max: 10 }
        ],
        assumptions: ["Define meaningful choices", "Interpret distribution, not single estimate"],
        gen: v => ({
          code: `library(specr)\nspecs <- setup(data=df, y=c("${v.Outcome[0]}"), x=c("${v.Treatment[0]}"),\n  controls=c(${v["Covariates to vary"].map(c => `"${c}"`).join(", ")}), model=c("lm","glm"))\nresults <- specr(specs)\nsummary(results)`,
          viz: `plot(results, type="curve") + theme_minimal()\nplot(results, type="choices")`
        })
      }
    ]},
    { family: "Sequence", methods: [
      { id: "seq", name: "Trajectory Analysis", desc: "Behavioral sequences", pkgs: ["TraMineR", "sequenceRCT"],
        needs: [
          { role: "State Variables (time-ordered)", types: ["Nominal", "Ordinal", "Binary"], min: 2, max: 20 },
          { role: "Group", types: ["Binary", "Nominal"], min: 0, max: 1 }
        ],
        assumptions: ["Discrete states", "Regular time intervals preferred"],
        gen: v => {
          const g = v.Group?.length ? `, group=df$${v.Group[0]}` : "";
          return {
            code: `library(TraMineR)\nseq_d <- seqdef(df[, c(${v["State Variables (time-ordered)"].map(c => `"${c}"`).join(", ")})])\nseqfplot(seq_d${g})\nseqdplot(seq_d${g})\nseqient(seq_d)`,
            viz: `seqIplot(seq_d, sortv="from.start")`
          };
        }
      }
    ]},
    { family: "Text / NLP", methods: [
      { id: "text", name: "Text Analysis", desc: "Tokenize, sentiment, topics", pkgs: ["tidytext", "quanteda", "stm"],
        needs: [
          { role: "Text Variable", types: ["Text"], min: 1, max: 1 },
          { role: "Grouping Variable", types: ["Nominal", "Binary"], min: 0, max: 1 }
        ],
        assumptions: ["Sufficient text data", "Preprocessing choices matter"],
        gen: v => ({
          code: `library(tidytext); library(quanteda)\ndf_tok <- df %>% unnest_tokens(word, ${v["Text Variable"][0]}) %>% anti_join(stop_words) %>% count(word, sort=TRUE)\ndf_sent <- df %>% unnest_tokens(word, ${v["Text Variable"][0]}) %>% inner_join(get_sentiments("bing")) %>% count(sentiment)\n\nlibrary(stm)\ncorpus <- corpus(df$${v["Text Variable"][0]})\ndfm <- dfm(tokens(corpus, remove_punct=TRUE)) %>% dfm_remove(stopwords("en"))\nstm_mod <- stm(dfm, K=5, verbose=FALSE)`,
          viz: `df_tok %>% top_n(20) %>% ggplot(aes(x=reorder(word,n), y=n)) + geom_col(fill="#3182ce") + coord_flip() + theme_minimal()\nplot(stm_mod, type="summary")`
        })
      }
    ]},
    { family: "Bayesian", methods: [
      { id: "breg", name: "Bayesian Regression", desc: "Priors + posterior inference", pkgs: ["brms", "bayestestR"],
        needs: [
          { role: "Outcome", types: ["Continuous", "Binary"], min: 1, max: 1 },
          { role: "Predictors", types: ANY, min: 1, max: 10 },
          { role: "Control Variables", types: ANY, min: 0, max: 10 }
        ],
        assumptions: ["Prior sensitivity analysis", "Rhat < 1.01", "ESS > 400"],
        gen: v => {
          const ctrl = v["Control Variables"]?.length ? ` + ${v["Control Variables"].join(" + ")}` : "";
          return {
            code: `library(brms); library(bayestestR)\nmodel <- brm(${v.Outcome[0]} ~ ${v.Predictors.join(" + ")}${ctrl}, data=df,\n  family=gaussian(), prior=c(set_prior("normal(0,10)", class="b")),\n  chains=4, iter=2000, seed=42)\nsummary(model)\ndescribe_posterior(model)\nrope(model)`,
            viz: `plot(model)\npp_check(model)`
          };
        }
      }
    ]},
    { family: "Meta-Analysis", methods: [
      { id: "meta", name: "Meta-Analysis (RE)", desc: "Pool effect sizes + forest plot", pkgs: ["metafor", "meta"],
        needs: [
          { role: "Effect Size", types: ["Continuous"], min: 1, max: 1 },
          { role: "Standard Error", types: ["Continuous"], min: 1, max: 1 },
          { role: "Study Label", types: ["Nominal", "Text"], min: 0, max: 1 },
          { role: "Moderators", types: ANY, min: 0, max: 5 }
        ],
        assumptions: ["Independent ES", "Correct ES metric", "Consistent ES definition", "I^2 > 75%: consider moderators"],
        gen: v => {
          const lab = v["Study Label"]?.length ? `, slab=df$${v["Study Label"][0]}` : "";
          const mod = v.Moderators?.length ? `\n\n# Meta-regression\nres_mr <- rma(yi=${v["Effect Size"][0]}, sei=${v["Standard Error"][0]}, mods=~${v.Moderators.join("+")}, data=df, method="REML")\nsummary(res_mr)` : "";
          return {
            code: `library(metafor); library(meta)\nres <- rma(yi=${v["Effect Size"][0]}, sei=${v["Standard Error"][0]}, data=df, method="REML"${lab})\nsummary(res)\npredict(res)\n\n# Publication bias\nregtest(res, model="lm")\nranktest(res)\nleave1out(res)${mod}`,
            viz: `forest(res, header=TRUE, xlab="Effect Size", col="darkblue")\nfunnel(res)\ntf <- trimfill(res); funnel(tf)`
          };
        }
      },
      { id: "meta_sub", name: "Subgroup Meta-Analysis", desc: "Pool by categorical moderator", pkgs: ["meta"],
        needs: [
          { role: "Effect Size", types: ["Continuous"], min: 1, max: 1 },
          { role: "Standard Error", types: ["Continuous"], min: 1, max: 1 },
          { role: "Subgroup Variable", types: ["Nominal", "Binary"], min: 1, max: 1 },
          { role: "Study Label", types: ["Nominal", "Text"], min: 0, max: 1 }
        ],
        assumptions: [">=3 studies per subgroup", "A priori subgroups"],
        gen: v => ({
          code: `library(meta)\nm <- metagen(TE=${v["Effect Size"][0]}, seTE=${v["Standard Error"][0]},\n  studlab=${v["Study Label"]?.length ? v["Study Label"][0] : 'paste0("Study_",1:nrow(df))'},\n  data=df, subgroup=${v["Subgroup Variable"][0]}, sm="SMD", random=TRUE, fixed=FALSE)\nsummary(m)`,
          viz: `forest(m, subgroup=TRUE, print.subgroup.name=TRUE, col.diamond="darkblue")`
        })
      }
    ]},
    { family: "Power", methods: [
      { id: "pwr", name: "Power Analysis", desc: "Sample size / power calculations", pkgs: ["pwr"],
        needs: [],
        assumptions: ["Small=0.2, medium=0.5, large=0.8"],
        gen: () => ({
          code: `library(pwr)\npwr.t.test(d=0.5, sig.level=0.05, power=0.80, type="two.sample")\npwr.anova.test(k=3, f=0.25, sig.level=0.05, power=0.80)\npwr.r.test(r=0.3, sig.level=0.05, power=0.80)\npwr.f2.test(u=5, f2=0.15, sig.level=0.05, power=0.80)`,
          viz: `d <- seq(0.1,1,by=0.05)\nn <- sapply(d, function(x) pwr.t.test(d=x,sig.level=0.05,power=0.80)$n)\ndata.frame(d=d,n=ceiling(n)) %>% ggplot(aes(x=d,y=n)) + geom_line(color="#3182ce",linewidth=1.2) + theme_minimal() + labs(title="N by Effect Size")`
        })
      }
    ]}
  ];
}

const CATALOG = buildCatalog();

const S = {
  app: { fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", maxWidth: 1280, margin: "0 auto", padding: 16, background: "#0f1117", color: "#e2e8f0", minHeight: "100vh" },
  hdr: { textAlign: "center", marginBottom: 20, padding: "16px 0", borderBottom: "1px solid #2d3748" },
  ttl: { fontSize: 26, fontWeight: 700, color: "#63b3ed", margin: 0 },
  sub: { color: "#a0aec0", fontSize: 13, marginTop: 4 },
  stepper: { display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap" },
  stepBtn: (a, d) => ({ padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: a ? "#3182ce" : d ? "#2d3748" : "#1a202c", color: a ? "#fff" : d ? "#63b3ed" : "#4a5568", fontWeight: a ? 600 : 400, fontSize: 13 }),
  card: { background: "#1a202c", borderRadius: 12, padding: 16, marginBottom: 14, border: "1px solid #2d3748" },
  btn: (c = "#3182ce") => ({ padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: c, color: "#fff", fontWeight: 500, fontSize: 13 }),
  sm: (c = "#3182ce") => ({ padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", background: c, color: "#fff", fontSize: 11, fontWeight: 500 }),
  out: { padding: "7px 14px", borderRadius: 8, border: "1px solid #4a5568", cursor: "pointer", background: "transparent", color: "#a0aec0", fontSize: 13 },
  tbl: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { padding: "7px 10px", background: "#2d3748", color: "#63b3ed", textAlign: "left", fontWeight: 600, borderBottom: "2px solid #4a5568", position: "sticky", top: 0 },
  td: { padding: "5px 10px", borderBottom: "1px solid #2d3748", color: "#cbd5e0", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  inp: { padding: "6px 10px", borderRadius: 6, border: "1px solid #4a5568", background: "#2d3748", color: "#e2e8f0", fontSize: 13, width: "100%", boxSizing: "border-box" },
  sel: { padding: "6px 10px", borderRadius: 6, border: "1px solid #4a5568", background: "#2d3748", color: "#e2e8f0", fontSize: 13 },
  code: { background: "#0d1117", borderRadius: 8, padding: 14, fontFamily: "'Fira Code',Consolas,monospace", fontSize: 12, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre-wrap", color: "#e2e8f0", border: "1px solid #21262d", maxHeight: 500, overflowY: "auto" },
  badge: c => ({ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: c + "22", color: c }),
  upload: { border: "2px dashed #4a5568", borderRadius: 12, padding: 40, textAlign: "center", cursor: "pointer" },
  mBar: p => ({ height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${p > 50 ? "#fc8181" : p > 20 ? "#f6ad55" : "#68d391"} ${p}%, #2d3748 ${p}%)`, width: 80 }),
  tag: { display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10, background: "#2d3748", color: "#a0aec0", marginRight: 4 },
  mCard: s => ({ padding: 12, borderRadius: 8, border: `1px solid ${s ? "#3182ce" : "#2d3748"}`, background: s ? "#1e3a5f" : "#0f1117", cursor: "pointer", marginBottom: 6 }),
  rSlot: { padding: 10, borderRadius: 8, border: "1px dashed #4a5568", background: "#0f1117", marginBottom: 8 },
};

export default function ProfResA() {
  const [step, setStep] = useState(0);
  const [hds, setHds] = useState([]);
  const [data, setData] = useState([]);
  const [fn, setFn] = useState("");
  const [rc, setRc] = useState([]);
  const [cfg, setCfg] = useState({});
  const [log, setLog] = useState([]);
  const [undo, setUndo] = useState([]);
  const [ann, setAnn] = useState(true);
  const [selM, setSelM] = useState(null);
  const [roles, setRoles] = useState({});
  const [aCode, setACode] = useState(null);
  const [recCol, setRecCol] = useState(null);
  const [recF, setRecF] = useState("");
  const [recT, setRecT] = useState("");
  const [cName, setCName] = useState("");
  const [cCols, setCCols] = useState([]);
  const [cOp, setCOp] = useState("sum");
  const [cThr, setCThr] = useState(3);
  const [cRev, setCRev] = useState([]);
  const [cMax, setCMax] = useState(5);
  const fRef = useRef();

  const addC = useCallback((code, a) => setRc(p => [...p, { code, annotation: a }]), []);
  const save = useCallback(() => setUndo(p => [...p.slice(-10), { data: JSON.parse(JSON.stringify(data)), hds: [...hds], cfg: { ...cfg } }]), [data, hds, cfg]);
  const doUndo = useCallback(() => {
    if (!undo.length) return;
    const l = undo[undo.length - 1];
    setData(l.data); setHds(l.hds); setCfg(l.cfg);
    setUndo(p => p.slice(0, -1));
    setLog(p => [...p, "↩️ Undo"]);
  }, [undo]);

  const handleFile = useCallback(file => {
    if (!file) return;
    setFn(file.name);
    const ext = file.name.split(".").pop().toLowerCase();
    const proc = (h, d) => {
      setHds(h); setData(d);
      const c = {};
      h.forEach(col => { c[col] = { cleanName: cln(col), type: inferType(d.map(r => r[col])), recodes: {}, original: col }; });
      setCfg(c); setStep(1);
    };
    if (ext === "csv") {
      Papa.parse(file, {
        complete: res => {
          const rows = res.data.filter(r => r.some(c => c !== ""));
          if (rows.length < 1) return;
          const h = rows[0].map((c, i) => c || `col_${i + 1}`);
          const d = rows.slice(1).map(r => { const o = {}; h.forEach((c, i) => o[c] = r[i] ?? ""); return o; });
          addC("library(tidyverse)\nlibrary(janitor)\nlibrary(readr)\nlibrary(naniar)\nlibrary(skimr)\nlibrary(visdat)", "Load packages.");
          addC(`df <- read_csv("${file.name}")`, "Import CSV.");
          proc(h, d);
        }, skipEmptyLines: true
      });
    } else if (["xlsx", "xls"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }).filter(r => r.some(c => c !== ""));
          if (rows.length < 1) return;
          const h = rows[0].map((c, i) => String(c || `col_${i + 1}`));
          const d = rows.slice(1).map(r => { const o = {}; h.forEach((c, i) => o[c] = r[i] ?? ""); return o; });
          addC("library(tidyverse)\nlibrary(janitor)\nlibrary(readxl)\nlibrary(naniar)\nlibrary(skimr)\nlibrary(visdat)", "Load packages.");
          addC(`df <- read_excel("${file.name}")`, "Import Excel.");
          proc(h, d);
        } catch (err) { alert("Error: " + err.message); }
      };
      reader.readAsArrayBuffer(file);
    } else { alert("Supported: CSV, XLSX, XLS"); }
  }, [addC]);

  const clean = useMemo(() => ({
    emptyCols: () => { save(); const empty = hds.filter(h => data.every(r => !r[h] || r[h] === "" || r[h] === "NA")); if (!empty.length) { setLog(p => [...p, "✅ No empty columns"]); return; } const nH = hds.filter(h => !empty.includes(h)); setHds(nH); setData(data.map(r => { const o = {}; nH.forEach(h => o[h] = r[h]); return o; })); const c = { ...cfg }; empty.forEach(h => delete c[h]); setCfg(c); setLog(p => [...p, `🗑️ Removed ${empty.length} empty col(s)`]); addC('df <- df %>% janitor::remove_empty("cols")', `Removed: ${empty.join(", ")}`); },
    emptyRows: () => { save(); const b = data.length; const nD = data.filter(r => hds.some(h => r[h] && r[h] !== "" && r[h] !== "NA")); setData(nD); const rm = b - nD.length; setLog(p => [...p, rm ? `🗑️ Removed ${rm} empty row(s)` : "✅ No empty rows"]); if (rm) addC('df <- df %>% janitor::remove_empty("rows")', `Removed ${rm} rows.`); },
    trim: () => { save(); setData(data.map(r => { const o = {}; hds.forEach(h => o[h] = typeof r[h] === "string" ? r[h].trim() : r[h]); return o; })); setLog(p => [...p, "✂️ Trimmed whitespace"]); addC("df <- df %>% mutate(across(where(is.character), str_trim))", "Trim whitespace."); },
    names: () => { save(); const nH = hds.map(cln); const uq = []; const seen = {}; nH.forEach(h => { seen[h] ? uq.push(`${h}_${++seen[h]}`) : ((seen[h] = 1), uq.push(h)); }); const nD = data.map(r => { const o = {}; hds.forEach((h, i) => o[uq[i]] = r[h]); return o; }); const nC = {}; hds.forEach((h, i) => { nC[uq[i]] = { ...cfg[h], cleanName: uq[i], original: cfg[h]?.original || h }; }); setHds(uq); setData(nD); setCfg(nC); setLog(p => [...p, "🏷️ Cleaned names"]); addC("df <- df %>% janitor::clean_names()", "Snake_case names."); },
    nas: () => { save(); const na = ["", "NA", "N/A", "n/a", "NULL", "null", "None", "none", "-", ".", "NaN", "#N/A", "missing", "Missing"]; setData(data.map(r => { const o = {}; hds.forEach(h => o[h] = na.includes(String(r[h]).trim()) ? "" : r[h]); return o; })); setLog(p => [...p, "🔄 Standardized NAs"]); addC('df <- df %>% naniar::replace_with_na_all(condition = ~.x %in% c("","N/A","NULL","None","none","-",".","NaN","#N/A","missing","Missing"))', "Standardize NAs."); }
  }), [save, hds, data, cfg, addC]);

  const stats = useMemo(() => {
    if (!data.length) return [];
    return hds.map(h => {
      const vals = data.map(r => r[h]);
      const miss = vals.filter(v => v === "" || v == null || v === "NA").length;
      const valid = vals.filter(v => v !== "" && v != null && v !== "NA");
      const u = new Set(valid.map(String)).size;
      const t = cfg[h]?.type || "Text";
      let st = {};
      if (t === "Continuous" || t === "Count") {
        const nums = valid.map(Number).filter(n => !isNaN(n));
        if (nums.length) {
          st.mean = (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
          st.min = Math.min(...nums);
          st.max = Math.max(...nums);
          st.median = [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)];
        }
      }
      return { col: h, type: t, miss, missPct: ((miss / vals.length) * 100).toFixed(1), uniq: u, ...st };
    });
  }, [data, hds, cfg]);

  const impute = useCallback((col, method) => {
    save();
    const vals = data.map(r => r[col]).filter(v => v !== "" && v != null && v !== "NA");
    let fv;
    if (method === "mean") { const n = vals.map(Number).filter(n => !isNaN(n)); fv = n.length ? (n.reduce((a, b) => a + b, 0) / n.length).toFixed(2) : ""; }
    else if (method === "median") { const n = vals.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b); fv = n.length ? n[Math.floor(n.length / 2)] : ""; }
    else { const f = _.countBy(vals, String); fv = Object.entries(f).sort((a, b) => b[1] - a[1])[0]?.[0] || ""; }
    if (!fv && fv !== 0) return;
    setData(data.map(r => ({ ...r, [col]: (r[col] === "" || r[col] == null || r[col] === "NA") ? String(fv) : r[col] })));
    setLog(p => [...p, `🩹 Imputed "${col}" with ${method} (${fv})`]);
    addC(`df <- df %>% mutate(${col}=ifelse(is.na(${col}),${method === "mode" ? `names(sort(table(${col}),decreasing=TRUE))[1]` : `${method}(${col},na.rm=TRUE)`},${col}))`, `Impute ${col} with ${method}.`);
  }, [data, save, addC]);

  const applyMap = useCallback(() => {
    save();
    const ren = {};
    hds.forEach(h => { const c = cfg[h]; if (c?.cleanName && c.cleanName !== h) ren[h] = c.cleanName; });
    const nH = hds.map(h => ren[h] || h);
    const nD = data.map(r => { const o = {}; hds.forEach(h => { const k = ren[h] || h; const c = cfg[h]; let v = r[h]; if (c?.recodes && c.recodes[v] !== undefined) v = c.recodes[v]; o[k] = v; }); return o; });
    const nC = {}; hds.forEach(h => { const k = ren[h] || h; nC[k] = { ...cfg[h], cleanName: k }; });
    setHds(nH); setData(nD); setCfg(nC);
    if (Object.keys(ren).length) addC(`df <- df %>% rename(${Object.entries(ren).map(([o, n]) => `${n}=\`${o}\``).join(", ")})`, "Rename.");
    hds.forEach(h => { const c = cfg[h]; const k = ren[h] || h; const t = c?.type;
      if (t === "Continuous") addC(`df <- df %>% mutate(${k}=as.numeric(${k}))`, `${k} to numeric.`);
      else if (t === "Binary" || t === "Nominal") addC(`df <- df %>% mutate(${k}=as.factor(${k}))`, `${k} to factor.`);
      else if (t === "Ordinal") addC(`df <- df %>% mutate(${k}=factor(${k},ordered=TRUE))`, `${k} to ordered factor.`);
      else if (t === "Date") addC(`df <- df %>% mutate(${k}=lubridate::parse_date_time(${k},orders=c("ymd","dmy","mdy")))`, `${k} to date.`);
      else if (t === "Count") addC(`df <- df %>% mutate(${k}=as.integer(${k}))`, `${k} to integer.`);
    });
    setLog(p => [...p, "✅ Applied mappings"]);
  }, [hds, data, cfg, save, addC]);

  const mkComposite = useCallback(() => {
    if (!cName || !cCols.length) return alert("Name the composite and select columns");
    save();
    const sn = cln(cName);
    const nD = data.map(r => {
      const vals = cCols.map(c => { let v = Number(r[c]); if (isNaN(v)) return null; if (cRev.includes(c)) v = (cMax + 1) - v; return v; }).filter(v => v !== null);
      let res;
      if (cOp === "sum") res = vals.reduce((a, b) => a + b, 0);
      else if (cOp === "mean") res = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
      else if (cOp === "subtract") res = vals.length >= 2 ? vals[0] - vals.slice(1).reduce((a, b) => a + b, 0) : vals[0];
      else if (cOp === "divide") res = vals.length >= 2 && vals[1] !== 0 ? (vals[0] / vals[1]).toFixed(3) : null;
      else if (cOp === "multiply") res = vals.reduce((a, b) => a * b, 1);
      else if (cOp === "count_above") res = vals.filter(v => v >= cThr).length;
      return { ...r, [sn]: res != null ? String(res) : "" };
    });
    setData(nD); setHds([...hds, sn]); setCfg({ ...cfg, [sn]: { cleanName: sn, type: "Continuous", recodes: {}, original: sn } });
    const rev = cRev.length ? `\n# Reverse-score\n${cRev.map(c => `df$${c} <- (${cMax + 1}) - df$${c}`).join("\n")}` : "";
    const opR = { sum: "rowSums", mean: "rowMeans", subtract: "-", divide: "/", multiply: "*", count_above: ">=" };
    const cols = cCols.map(c => `"${c}"`).join(",");
    let rcode;
    if (cOp === "sum" || cOp === "mean") rcode = `df$${sn} <- ${opR[cOp]}(df[,c(${cols})], na.rm=TRUE)`;
    else if (cOp === "count_above") rcode = `df$${sn} <- rowSums(df[,c(${cols})] >= ${cThr}, na.rm=TRUE)`;
    else rcode = `df$${sn} <- df$${cCols[0]} ${opR[cOp]} df$${cCols[1] || cCols[0]}`;
    addC(`${rev}\n${rcode}\n\n# Reliability\nlibrary(psych)\nalpha(df[,c(${cols})])`, `Composite "${sn}" (${cOp}).`);
    setLog(p => [...p, `📐 Created "${sn}"`]);
    setCName(""); setCCols([]); setCRev([]);
  }, [cName, cCols, cOp, cThr, cRev, cMax, data, hds, cfg, save, addC]);

  const genAnalysis = useCallback(() => {
    if (!selM) return;
    const m = CATALOG.flatMap(f => f.methods).find(x => x.id === selM);
    if (!m) return;
    for (const n of m.needs) {
      if (n.min > 0 && (!roles[n.role] || roles[n.role].length < n.min))
        return alert(`Assign at least ${n.min} variable(s) to "${n.role}"`);
    }
    const { code, viz } = m.gen(roles);
    let full = `# ${"=".repeat(50)}\n# ${m.name}\n# Packages: ${m.pkgs.join(", ")}\n# ${"=".repeat(50)}\n\n${code}`;
    if (viz) full += `\n\n# --- Visualization ---\n${viz}`;
    if (m.assumptions.length) full += `\n\n# --- Assumptions ---\n${m.assumptions.map(a => `# ! ${a}`).join("\n")}`;
    setACode(full);
    addC(full, `${m.name}. Pkgs: ${m.pkgs.join(", ")}`);
  }, [selM, roles, addC]);

  const fullCode = useMemo(() => rc.map(r => ann ? `# ${r.annotation}\n${r.code}` : r.code).join("\n\n"), [rc, ann]);
  const dlCSV = useCallback(() => { const csv = Papa.unparse({ fields: hds, data: data.map(r => hds.map(h => r[h])) }); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `cleaned_${fn || "data.csv"}`; a.click(); }, [hds, data, fn]);
  const dlR = useCallback(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([fullCode], { type: "text/plain" })); a.download = "analysis_script.R"; a.click(); }, [fullCode]);

  const curM = CATALOG.flatMap(f => f.methods).find(x => x.id === selM);
  const numCols = hds.filter(h => ["Continuous", "Ordinal", "Count"].includes(cfg[h]?.type));

  return (
    <div style={S.app}>
      <div style={S.hdr}>
        <h1 style={S.ttl}>🔬 Prof ResA</h1>
        <p style={S.sub}>Professor Research Assistant — Import → Clean → Setup → Analyze → Export</p>
      </div>
      <div style={S.stepper}>
        {STEPS.map((s, i) => <button key={s} style={S.stepBtn(step === i, i < step)} onClick={() => (data.length || i === 0) && setStep(i)}>{i < step ? "✓ " : ""}{s}</button>)}
        {data.length > 0 && <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#a0aec0" }}>{data.length}r × {hds.length}c</span>
          <button style={S.out} onClick={doUndo}>↩️ Undo</button>
        </div>}
      </div>

      {step === 0 && <div style={S.card}><div style={S.upload} onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer?.files?.[0]); }} onDragOver={e => e.preventDefault()} onClick={() => fRef.current?.click()}>
        <input ref={fRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
        <div style={{ fontSize: 48, marginBottom: 12 }}>📁</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Drop your file here or click to browse</div>
        <div style={{ color: "#a0aec0", fontSize: 13 }}>CSV, Excel (.xlsx, .xls)</div>
      </div></div>}

      {step === 1 && <>
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>🧼 Cleaning</h3>
            <span style={S.tag}>Each action updates data + generates R code</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={S.btn("#e53e3e")} onClick={clean.emptyCols}>Remove Empty Cols</button>
            <button style={S.btn("#e53e3e")} onClick={clean.emptyRows}>Remove Empty Rows</button>
            <button style={S.btn("#dd6b20")} onClick={clean.trim}>Trim Whitespace</button>
            <button style={S.btn("#38a169")} onClick={clean.names}>Clean Column Names</button>
            <button style={S.btn("#805ad5")} onClick={clean.nas}>Standardize NAs</button>
          </div>
          {log.length > 0 && <div style={{ marginTop: 12, padding: 10, background: "#0f1117", borderRadius: 8, maxHeight: 120, overflowY: "auto" }}>{log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#a0aec0", padding: "2px 0" }}>{l}</div>)}</div>}
        </div>
        <div style={S.card}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>📋 Preview</h3>
          <div style={{ overflowX: "auto", maxHeight: 300, overflowY: "auto" }}>
            <table style={S.tbl}><thead><tr>{hds.map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>{data.slice(0, 40).map((r, i) => <tr key={i} style={{ background: i % 2 ? "#1e2533" : "transparent" }}>{hds.map(h => <td key={h} style={{ ...S.td, color: (r[h] === "" || r[h] == null) ? "#fc8181" : "#cbd5e0" }}>{r[h] === "" || r[h] == null ? "—" : String(r[h]).slice(0, 50)}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {data.length > 40 && <div style={{ fontSize: 11, color: "#718096", marginTop: 6, textAlign: "center" }}>Showing 40 of {data.length}</div>}
        </div>
      </>}

      {step === 2 && <>
        <div style={S.card}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>📊 Summary & Imputation</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={S.tbl}>
              <thead><tr><th style={S.th}>Column</th><th style={S.th}>Type</th><th style={S.th}>Missing</th><th style={S.th}>Bar</th><th style={S.th}>Unique</th><th style={S.th}>Stats</th><th style={S.th}>Impute</th></tr></thead>
              <tbody>{stats.map((s, i) => <tr key={s.col} style={{ background: i % 2 ? "#1e2533" : "transparent" }}>
                <td style={S.td}><strong>{s.col}</strong></td>
                <td style={S.td}><span style={S.badge(VAR_CLR[s.type] || "#a0aec0")}>{s.type}</span></td>
                <td style={S.td}><span style={{ color: s.miss > 0 ? "#fc8181" : "#68d391" }}>{s.miss} ({s.missPct}%)</span></td>
                <td style={S.td}><div style={S.mBar(parseFloat(s.missPct))} /></td>
                <td style={S.td}>{s.uniq}</td>
                <td style={{ ...S.td, fontSize: 11 }}>{s.mean !== undefined ? `μ=${s.mean} | med=${s.median} | ${s.min}–${s.max}` : data.map(r => r[s.col]).filter(v => v && v !== "").slice(0, 3).join(", ")}</td>
                <td style={S.td}>{s.miss > 0 && <div style={{ display: "flex", gap: 3 }}>
                  {(s.type === "Continuous" || s.type === "Count") && <><button style={S.sm("#38a169")} onClick={() => impute(s.col, "mean")}>Mean</button><button style={S.sm("#3182ce")} onClick={() => impute(s.col, "median")}>Med</button></>}
                  <button style={S.sm("#805ad5")} onClick={() => impute(s.col, "mode")}>Mode</button>
                </div>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <div style={S.card}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p style={{ color: "#a0aec0", fontSize: 13, margin: 0 }}>🩹 Add <code style={{ color: "#63b3ed" }}>mice</code> multiple imputation</p>
          <button style={S.btn()} onClick={() => { addC("library(mice)\nmd.pattern(df)\nimp <- mice(df, m=5, method='pmm', seed=42)\ndf_imp <- complete(imp, 1)", "mice imputation."); setLog(p => [...p, "📦 Added mice"]); }}>Add mice code</button>
        </div></div>
      </>}

      {step === 3 && <>
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div><h3 style={{ margin: 0, fontSize: 15 }}>🗺️ Variable Setup</h3><p style={{ color: "#a0aec0", fontSize: 13, margin: "4px 0 0" }}>Types, rename, recode</p></div>
            <button style={S.btn("#38a169")} onClick={applyMap}>Apply All ✓</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={S.tbl}>
              <thead><tr><th style={S.th}>Column</th><th style={S.th}>Rename</th><th style={S.th}>Type</th><th style={S.th}>Recodes</th><th style={S.th}></th></tr></thead>
              <tbody>{hds.map((h, i) => { const c = cfg[h] || {}; return (
                <tr key={h} style={{ background: i % 2 ? "#1e2533" : "transparent" }}>
                  <td style={S.td}><code style={{ color: "#63b3ed" }}>{h}</code></td>
                  <td style={S.td}><input style={{ ...S.inp, width: 130 }} value={c.cleanName || ""} onChange={e => setCfg(p => ({ ...p, [h]: { ...p[h], cleanName: e.target.value } }))} /></td>
                  <td style={S.td}><select style={S.sel} value={c.type || "Text"} onChange={e => setCfg(p => ({ ...p, [h]: { ...p[h], type: e.target.value } }))}>{VAR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></td>
                  <td style={S.td}>{c.recodes && Object.entries(c.recodes).map(([f, t]) => <span key={f} style={S.tag}>{f}→{t}</span>)}</td>
                  <td style={S.td}><button style={S.sm("#805ad5")} onClick={() => setRecCol(recCol === h ? null : h)}>{recCol === h ? "Close" : "Recode"}</button></td>
                </tr>); })}</tbody>
            </table>
          </div>
        </div>
        {recCol && <div style={S.card}>
          <h4 style={{ margin: "0 0 10px", fontSize: 14 }}>Recode <code style={{ color: "#63b3ed" }}>{recCol}</code></h4>
          <div style={{ marginBottom: 10, fontSize: 12, color: "#a0aec0" }}>
            {[...new Set(data.map(r => r[recCol]).filter(v => v && v !== ""))].slice(0, 15).map(v => <button key={v} style={{ ...S.tag, cursor: "pointer" }} onClick={() => setRecF(String(v))}>{String(v)}</button>)}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input style={{ ...S.inp, width: 130 }} placeholder="From" value={recF} onChange={e => setRecF(e.target.value)} />
            <span style={{ color: "#a0aec0" }}>→</span>
            <input style={{ ...S.inp, width: 130 }} placeholder="To" value={recT} onChange={e => setRecT(e.target.value)} />
            <button style={S.btn()} onClick={() => { if (!recCol || !recF) return; setCfg(p => ({ ...p, [recCol]: { ...p[recCol], recodes: { ...(p[recCol]?.recodes || {}), [recF]: recT } } })); setRecF(""); setRecT(""); }}>Add</button>
          </div>
        </div>}
        <div style={S.card}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>📐 Composite Score Builder</h3>
          <p style={{ color: "#a0aec0", fontSize: 12, margin: "0 0 12px" }}>Combine items into a single score with optional reverse-scoring. Generates Cronbach's alpha.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div><label style={{ fontSize: 12, color: "#a0aec0", display: "block", marginBottom: 4 }}>Name</label><input style={S.inp} value={cName} onChange={e => setCName(e.target.value)} placeholder="e.g., anxiety_total" /></div>
            <div><label style={{ fontSize: 12, color: "#a0aec0", display: "block", marginBottom: 4 }}>Operation</label>
              <select style={{ ...S.sel, width: "100%" }} value={cOp} onChange={e => setCOp(e.target.value)}>
                <option value="sum">Sum</option><option value="mean">Mean</option><option value="subtract">Subtract (A-B)</option>
                <option value="divide">Divide (A/B)</option><option value="multiply">Multiply</option><option value="count_above">Count above threshold</option>
              </select>
            </div>
          </div>
          {cOp === "count_above" && <div style={{ marginBottom: 12 }}><label style={{ fontSize: 12, color: "#a0aec0" }}>Threshold</label><input type="number" style={{ ...S.inp, width: 80 }} value={cThr} onChange={e => setCThr(Number(e.target.value))} /></div>}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "#a0aec0", display: "block", marginBottom: 4 }}>Select Items</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{numCols.map(h => { const sel = cCols.includes(h); return <button key={h} style={S.sm(sel ? "#38a169" : "#4a5568")} onClick={() => setCCols(p => sel ? p.filter(x => x !== h) : [...p, h])}>{sel ? "✓ " : ""}{h}</button>; })}</div>
          </div>
          {cCols.length > 0 && <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "#a0aec0", display: "block", marginBottom: 4 }}>Reverse-score? (click to toggle)</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {cCols.map(h => { const rev = cRev.includes(h); return <button key={h} style={S.sm(rev ? "#e53e3e" : "#2d3748")} onClick={() => setCRev(p => rev ? p.filter(x => x !== h) : [...p, h])}>{rev ? "🔄 " : ""}{h}</button>; })}
              <span style={{ fontSize: 11, color: "#718096", marginLeft: 8 }}>Max:</span>
              <input type="number" style={{ ...S.inp, width: 50 }} value={cMax} onChange={e => setCMax(Number(e.target.value))} />
            </div>
          </div>}
          <button style={S.btn("#38a169")} onClick={mkComposite}>Create Composite ✓</button>
        </div>
      </>}

      {step === 4 && <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
        <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
          {CATALOG.map(fam => <div key={fam.family} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#63b3ed", padding: "4px 0", marginBottom: 4, borderBottom: "1px solid #2d3748" }}>{fam.family}</div>
            {fam.methods.map(m => <div key={m.id} style={S.mCard(selM === m.id)} onClick={() => { setSelM(m.id); setRoles({}); setACode(null); }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
              <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 2 }}>{m.desc}</div>
              <div style={{ marginTop: 4 }}>{m.pkgs.map(p => <span key={p} style={{ ...S.tag, fontSize: 9 }}>{p}</span>)}</div>
            </div>)}
          </div>)}
        </div>
        <div>
          {!curM && <div style={{ ...S.card, textAlign: "center", padding: 40 }}><div style={{ fontSize: 40, marginBottom: 12 }}>👈</div><p style={{ color: "#a0aec0" }}>Select an analysis method</p></div>}
          {curM && <>
            <div style={S.card}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{curM.name}</h3>
              <p style={{ color: "#a0aec0", fontSize: 13, margin: "0 0 14px" }}>{curM.desc} — <code style={{ color: "#63b3ed" }}>{curM.pkgs.join(", ")}</code></p>
              {curM.needs.map(need => <div key={need.role} style={S.rSlot}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#63b3ed", marginBottom: 6 }}>
                  {need.role} <span style={{ fontWeight: 400, color: "#718096" }}>({need.types.join("/")} — {need.min === 0 ? "optional" : `${need.min}–${need.max}`})</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {hds.filter(h => need.types.includes(cfg[h]?.type)).map(h => {
                    const a = (roles[need.role] || []).includes(h);
                    return <button key={h} style={{ ...S.sm(a ? "#38a169" : "#4a5568"), opacity: a ? 1 : 0.7 }} onClick={() => setRoles(p => {
                      const cur = p[need.role] || [];
                      if (a) return { ...p, [need.role]: cur.filter(x => x !== h) };
                      if (cur.length >= need.max) return p;
                      return { ...p, [need.role]: [...cur, h] };
                    })}>{a ? "✓ " : ""}{h}</button>;
                  })}
                  {hds.filter(h => need.types.includes(cfg[h]?.type)).length === 0 && <span style={{ fontSize: 12, color: "#fc8181" }}>No matching variables — check Variables tab</span>}
                </div>
              </div>)}
              {curM.assumptions.length > 0 && <div style={{ marginTop: 12, padding: 10, background: "#0f1117", borderRadius: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#f6ad55", marginBottom: 6 }}>⚠️ Assumptions:</div>
                {curM.assumptions.map((a, i) => <div key={i} style={{ fontSize: 12, color: "#a0aec0", padding: "2px 0" }}>• {a}</div>)}
              </div>}
              <div style={{ marginTop: 14 }}><button style={S.btn("#38a169")} onClick={genAnalysis}>Generate R Code ✓</button></div>
            </div>
            {aCode && <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h4 style={{ margin: 0, fontSize: 14 }}>Generated Code</h4>
                <button style={S.btn()} onClick={() => navigator.clipboard.writeText(aCode)}>Copy</button>
              </div>
              <div style={S.code}>{aCode}</div>
            </div>}
          </>}
        </div>
      </div>}

      {step === 5 && <>
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div><h3 style={{ margin: 0, fontSize: 15 }}>📜 Complete R Script</h3><p style={{ color: "#a0aec0", fontSize: 13, margin: "4px 0 0" }}>Import → Clean → Composite → Analysis → Visualization</p></div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "#a0aec0" }}><input type="checkbox" checked={ann} onChange={e => setAnn(e.target.checked)} /> 📚 Annotations</label>
              <button style={S.btn()} onClick={() => navigator.clipboard.writeText(fullCode)}>Copy</button>
              <button style={S.btn("#38a169")} onClick={dlR}>Download .R</button>
              <button style={S.btn("#dd6b20")} onClick={dlCSV}>Download CSV</button>
            </div>
          </div>
          <div style={S.code}>{rc.length === 0 ? <span style={{ color: "#4a5568" }}>No code yet — go through the workflow!</span> : rc.map((r, i) => <div key={i} style={{ marginBottom: 12 }}>{ann && <div style={{ color: "#6a9955", fontStyle: "italic" }}>{"# " + r.annotation}</div>}<div>{r.code}</div></div>)}</div>
        </div>
        <div style={S.card}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>📦 Quick Add</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(report)\nreport(model)", "APA output.")}>APA Output</button>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(effectsize)\ncohens_d(outcome ~ group, data=df)\neta_squared(aov_result)", "Effect sizes.")}>Effect Sizes</button>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(pwr)\npwr.t.test(d=0.5, sig.level=0.05, power=0.80)", "Power analysis.")}>Power</button>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(flextable); library(officer)\nft <- flextable(results)\nsave_as_docx(ft, path='table.docx')", "Word export.")}>Export Word</button>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(performance)\ncheck_model(model)\ncheck_normality(model)\ncheck_heteroscedasticity(model)\ncheck_collinearity(model)", "Diagnostics.")}>Diagnostics</button>
            <button style={S.btn("#3182ce")} onClick={() => addC("library(visdat)\nvis_dat(df)\nvis_miss(df)", "Visual overview.")}>Visual Overview</button>
          </div>
        </div>
      </>}
    </div>
  );
}
