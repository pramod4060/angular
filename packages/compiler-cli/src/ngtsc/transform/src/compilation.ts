/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ConstantPool, Type} from '@angular/compiler';
import * as ts from 'typescript';

import {ErrorCode, FatalDiagnosticError} from '../../diagnostics';
import {ImportRewriter} from '../../imports';
import {IncrementalDriver} from '../../incremental';
import {IndexingContext} from '../../indexer';
import {ModuleWithProvidersScanner} from '../../modulewithproviders';
import {PerfRecorder} from '../../perf';
import {ClassDeclaration, ReflectionHost, isNamedClassDeclaration} from '../../reflection';
import {LocalModuleScopeRegistry} from '../../scope';
import {TypeCheckContext} from '../../typecheck';
import {getSourceFile, isExported} from '../../util/src/typescript';

import {AnalysisOutput, CompileResult, DecoratorHandler, DetectResult, HandlerPrecedence, ResolveResult} from './api';
import {DtsTransformRegistry} from './declaration';
import {Trait, TraitState} from './trait';

const EMPTY_ARRAY: any = [];

/**
 * Records information about a specific class that has matched traits.
 */
interface ClassRecord {
  /**
   * The `ClassDeclaration` of the class which has Angular traits applied.
   */
  node: ClassDeclaration;

  /**
   * All traits which matched on the class.
   */
  traits: Trait<unknown, unknown, unknown>[];

  /**
   * Meta-diagnostics about the class, which are usually related to whether certain combinations of
   * Angular decorators are not permitted.
   */
  metaDiagnostics: ts.Diagnostic[]|null;

  // Subsequent fields are "internal" and used during the matching of `DecoratorHandler`s. This is
  // mutable state during the `detect`/`analyze` phases of compilation.

  /**
   * Whether `traits` contains traits matched from `DecoratorHandler`s marked as `WEAK`.
   */
  hasWeakHandlers: boolean;

  /**
   * Whether `traits` contains a trait from a `DecoratorHandler` matched as `PRIMARY`.
   */
  hasPrimaryHandler: boolean;
}

/**
 * The heart of Angular compilation.
 *
 * The `TraitCompiler` is responsible for processing all classes in the program and
 */
export class TraitCompiler {
  /**
   * Maps class declarations to their `ClassRecord`, which tracks the Ivy traits being applied to
   * those classes.
   */
  private classes = new Map<ClassDeclaration, ClassRecord>();

  /**
   * Maps source files to any class declaration(s) within them which have been discovered to contain
   * Ivy traits.
   */
  private fileToClasses = new Map<ts.SourceFile, Set<ClassDeclaration>>();

  private reexportMap = new Map<string, Map<string, [string, string]>>();

  /**
   * @param handlers array of `DecoratorHandler`s which will be executed against each class in the
   * program
   * @param checker TypeScript `TypeChecker` instance for the program
   * @param reflector `ReflectionHost` through which all reflection operations will be performed
   * @param coreImportsFrom a TypeScript `SourceFile` which exports symbols needed for Ivy imports
   * when compiling @angular/core, or `null` if the current program is not @angular/core. This is
   * `null` in most cases.
   */
  constructor(
      private handlers: DecoratorHandler<unknown, unknown, unknown>[],
      private reflector: ReflectionHost, private importRewriter: ImportRewriter,
      private incrementalDriver: IncrementalDriver, private perf: PerfRecorder,
      private sourceToFactorySymbols: Map<string, Set<string>>|null,
      private scopeRegistry: LocalModuleScopeRegistry, private compileNonExportedClasses: boolean,
      private dtsTransforms: DtsTransformRegistry, private mwpScanner: ModuleWithProvidersScanner) {
  }

  analyzeSync(sf: ts.SourceFile): void { this.analyze(sf, false); }

  analyzeAsync(sf: ts.SourceFile): Promise<void>|void { return this.analyze(sf, true); }

  private analyze(sf: ts.SourceFile, preanalyze: false): void;
  private analyze(sf: ts.SourceFile, preanalyze: true): Promise<void>|void;
  private analyze(sf: ts.SourceFile, preanalyze: boolean): Promise<void>|void {
    const promises: Promise<void>[] = [];

    const visit = (node: ts.Node): void => {
      if (isNamedClassDeclaration(node)) {
        this.analyzeClass(node, preanalyze ? promises : null);
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);

    this.mwpScanner.scan(sf, {
      addTypeReplacement: (node: ts.Declaration, type: Type): void => {
        // Only obtain the return type transform for the source file once there's a type to replace,
        // so that no transform is allocated when there's nothing to do.
        this.dtsTransforms.getReturnTypeTransform(sf).addTypeReplacement(node, type);
      }
    });

    if (preanalyze && promises.length > 0) {
      return Promise.all(promises).then(() => undefined as void);
    } else {
      return;
    }
  }

  private scanClassForTraits(clazz: ClassDeclaration): ClassRecord|null {
    if (!this.compileNonExportedClasses && !isExported(clazz)) {
      return null;
    }

    const decorators = this.reflector.getDecoratorsOfDeclaration(clazz);

    let record: ClassRecord|null = null;

    for (const handler of this.handlers) {
      const result = handler.detect(clazz, decorators);
      if (result === undefined) {
        continue;
      }


      const isPrimaryHandler = handler.precedence === HandlerPrecedence.PRIMARY;
      const isWeakHandler = handler.precedence === HandlerPrecedence.WEAK;
      const trait = Trait.pending(handler, result);

      if (record === null) {
        // This is the first handler to match this class. This path is a fast path through which
        // most classes will flow.
        record = {
          node: clazz,
          traits: [trait],
          metaDiagnostics: null,
          hasPrimaryHandler: isPrimaryHandler,
          hasWeakHandlers: isWeakHandler,
        };

        this.classes.set(clazz, record);
        const sf = clazz.getSourceFile();
        if (!this.fileToClasses.has(sf)) {
          this.fileToClasses.set(sf, new Set<ClassDeclaration>());
        }
        this.fileToClasses.get(sf) !.add(clazz);
      } else {
        // This is at least the second handler to match this class. This is a slower path that some
        // classes will go through, which validates that the set of decorators applied to the class
        // is valid.

        // Validate according to rules as follows:
        //
        // * WEAK handlers are removed if a non-WEAK handler matches.
        // * Only one PRIMARY handler can match at a time. Any other PRIMARY handler matching a
        //   class with an existing PRIMARY handler is an error.

        if (!isWeakHandler && record.hasWeakHandlers) {
          // The current handler is not a WEAK handler, but the class has other WEAK handlers.
          // Remove them.
          record.traits =
              record.traits.filter(field => field.handler.precedence !== HandlerPrecedence.WEAK);
          record.hasWeakHandlers = false;
        } else if (isWeakHandler && !record.hasWeakHandlers) {
          // The current handler is a WEAK handler, but the class has non-WEAK handlers already.
          // Drop the current one.
          continue;
        }

        if (isPrimaryHandler && record.hasPrimaryHandler) {
          // The class already has a PRIMARY handler, and another one just matched.
          record.metaDiagnostics = [{
            category: ts.DiagnosticCategory.Error,
            code: Number('-99' + ErrorCode.DECORATOR_COLLISION),
            file: getSourceFile(clazz),
            start: clazz.getStart(undefined, false),
            length: clazz.getWidth(),
            messageText: 'Two incompatible decorators on class',
          }];
          record.traits = [];
          return record;
        }

        // Otherwise, it's safe to accept the multiple decorators here. Update some of the metadata
        // regarding this class.
        record.traits.push(trait);
        record.hasPrimaryHandler = record.hasPrimaryHandler || isPrimaryHandler;
      }
    }

    return record;
  }

  private analyzeClass(clazz: ClassDeclaration, preanalyzeQueue: Promise<void>[]|null): void {
    const record = this.scanClassForTraits(clazz);

    if (record === null) {
      // There are no Ivy traits on the class, so it can safely be skipped.
      return;
    }

    for (const trait of record.traits) {
      const analyze = () => this.analyzeTrait(clazz, trait);

      let preanalysis: Promise<void>|null = null;
      if (preanalyzeQueue !== null && trait.handler.preanalyze !== undefined) {
        preanalysis = trait.handler.preanalyze(clazz, trait.detected.metadata) || null;
      }
      if (preanalysis !== null) {
        preanalyzeQueue !.push(preanalysis.then(analyze));
      } else {
        analyze();
      }
    }
  }

  private analyzeTrait(clazz: ClassDeclaration, trait: Trait<unknown, unknown, unknown>): void {
    if (trait.state !== TraitState.PENDING) {
      throw new Error(
          `Attempt to analyze trait of ${clazz.name.text} in state ${TraitState[trait.state]} (expected DETECTED)`);
    }

    // Attempt analysis. This could fail with a `FatalDiagnosticError`; catch it if it does.
    let result: AnalysisOutput<unknown>;
    try {
      result = trait.handler.analyze(clazz, trait.detected.metadata);
    } catch (err) {
      if (err instanceof FatalDiagnosticError) {
        trait = trait.toErrored([err.toDiagnostic()]);
        return;
      } else {
        throw err;
      }
    }

    if (result.diagnostics !== undefined) {
      trait = trait.toErrored(result.diagnostics);
    } else if (result.analysis !== undefined) {
      trait = trait.toAnalyzed(result.analysis);

      const sf = clazz.getSourceFile();
      if (result.factorySymbolName !== undefined && this.sourceToFactorySymbols !== null &&
          this.sourceToFactorySymbols.has(sf.fileName)) {
        this.sourceToFactorySymbols.get(sf.fileName) !.add(result.factorySymbolName);
      }
    } else {
      trait = trait.toSkipped();
    }
  }

  resolve(): void {
    const classes = Array.from(this.classes.keys());
    for (const clazz of classes) {
      const record = this.classes.get(clazz) !;
      for (let trait of record.traits) {
        const handler = trait.handler;
        switch (trait.state) {
          case TraitState.SKIPPED:
          case TraitState.ERRORED:
            continue;
          case TraitState.PENDING:
            throw new Error(
                `Resolving a trait that hasn't been analyzed: ${clazz.name.text} / ${Object.getPrototypeOf(trait.handler).constructor.name}`);
          case TraitState.RESOLVED:
            throw new Error(`Resolving an already resolved trait`);
        }

        if (handler.resolve === undefined) {
          // No resolution of this trait needed - it's considered successful by default.
          trait = trait.toResolved(null);
          continue;
        }

        let result: ResolveResult<unknown>;
        try {
          result = handler.resolve(clazz, trait.analysis as Readonly<unknown>);
        } catch (err) {
          if (err instanceof FatalDiagnosticError) {
            trait = trait.toErrored([err.toDiagnostic()]);
            continue;
          } else {
            throw err;
          }
        }

        if (result.diagnostics !== undefined) {
          trait = trait.toErrored(result.diagnostics);
        } else {
          if (result.data !== undefined) {
            trait = trait.toResolved(result.data);
          } else {
            trait = trait.toResolved(null);
          }
        }

        if (result.reexports !== undefined) {
          const fileName = clazz.getSourceFile().fileName;
          if (!this.reexportMap.has(fileName)) {
            this.reexportMap.set(fileName, new Map<string, [string, string]>());
          }
          const fileReexports = this.reexportMap.get(fileName) !;
          for (const reexport of result.reexports) {
            fileReexports.set(reexport.asAlias, [reexport.fromModule, reexport.symbolName]);
          }
        }
      }
    }

    this.recordNgModuleScopeDependencies();
  }

  typeCheck(ctx: TypeCheckContext): void {
    for (const clazz of this.classes.keys()) {
      const record = this.classes.get(clazz) !;
      for (const trait of record.traits) {
        if (trait.state !== TraitState.RESOLVED) {
          continue;
        } else if (trait.handler.typeCheck === undefined) {
          continue;
        }
        trait.handler.typeCheck(ctx, clazz, trait.analysis, trait.resolution);
      }
    }
  }

  index(ctx: IndexingContext): void {
    for (const clazz of this.classes.keys()) {
      const record = this.classes.get(clazz) !;
      for (const trait of record.traits) {
        if (trait.state !== TraitState.RESOLVED) {
          // Skip traits that haven't been resolved successfully.
          continue;
        } else if (trait.handler.index === undefined) {
          // Skip traits that don't affect indexing.
          continue;
        }

        trait.handler.index(ctx, clazz, trait.analysis, trait.resolution);
      }
    }
  }

  compile(clazz: ts.Declaration, constantPool: ConstantPool): CompileResult[]|null {
    const original = ts.getOriginalNode(clazz) as typeof clazz;
    if (!isNamedClassDeclaration(clazz) || !isNamedClassDeclaration(original) ||
        !this.classes.has(original)) {
      return null;
    }

    const record = this.classes.get(original) !;

    let res: CompileResult[] = [];

    for (const trait of record.traits) {
      if (trait.state !== TraitState.RESOLVED) {
        continue;
      }

      const compileSpan = this.perf.start('compileClass', original);
      const compileMatchRes =
          trait.handler.compile(clazz, trait.analysis, trait.resolution, constantPool);
      this.perf.stop(compileSpan);
      if (Array.isArray(compileMatchRes)) {
        for (const result of compileMatchRes) {
          if (!res.some(r => r.name === result.name)) {
            res.push(result);
          }
        }
      } else if (!res.some(result => result.name === compileMatchRes.name)) {
        res.push(compileMatchRes);
      }
    }

    // Look up the .d.ts transformer for the input file and record that at least one field was
    // generated, which will allow the .d.ts to be transformed later.
    this.dtsTransforms.getIvyDeclarationTransform(original.getSourceFile())
        .addFields(original, res);

    // Return the instruction to the transformer so the fields will be added.
    return res.length > 0 ? res : null;
  }

  decoratorsFor(node: ts.Declaration): ts.Decorator[] {
    const original = ts.getOriginalNode(node) as typeof node;
    if (!isNamedClassDeclaration(original) || !this.classes.has(original)) {
      return [];
    }

    const record = this.classes.get(original) !;
    const decorators: ts.Decorator[] = [];

    for (const trait of record.traits) {
      if (trait.state !== TraitState.RESOLVED) {
        continue;
      }

      if (trait.detected.trigger !== null && ts.isDecorator(trait.detected.trigger)) {
        decorators.push(trait.detected.trigger);
      }
    }

    return decorators;
  }

  get diagnostics(): ReadonlyArray<ts.Diagnostic> {
    const diagnostics: ts.Diagnostic[] = [];
    for (const clazz of this.classes.keys()) {
      const record = this.classes.get(clazz) !;
      if (record.metaDiagnostics !== null) {
        diagnostics.push(...record.metaDiagnostics);
      }
      for (const trait of record.traits) {
        if (trait.state === TraitState.ERRORED) {
          diagnostics.push(...trait.diagnostics);
        }
      }
    }
    return diagnostics;
  }

  get exportStatements(): Map<string, Map<string, [string, string]>> { return this.reexportMap; }

  private recordNgModuleScopeDependencies() {
    const recordSpan = this.perf.start('recordDependencies');
    for (const scope of this.scopeRegistry.getCompilationScopes()) {
      const file = scope.declaration.getSourceFile();
      const ngModuleFile = scope.ngModule.getSourceFile();

      // A change to any dependency of the declaration causes the declaration to be invalidated,
      // which requires the NgModule to be invalidated as well.
      const deps = this.incrementalDriver.getFileDependencies(file);
      this.incrementalDriver.trackFileDependencies(deps, ngModuleFile);

      // A change to the NgModule file should cause the declaration itself to be invalidated.
      this.incrementalDriver.trackFileDependency(ngModuleFile, file);

      // A change to any directive/pipe in the compilation scope should cause the declaration to be
      // invalidated.
      for (const directive of scope.directives) {
        const dirSf = directive.ref.node.getSourceFile();

        // When a directive in scope is updated, the declaration needs to be recompiled as e.g.
        // a selector may have changed.
        this.incrementalDriver.trackFileDependency(dirSf, file);

        // When any of the dependencies of the declaration changes, the NgModule scope may be
        // affected so a component within scope must be recompiled. Only components need to be
        // recompiled, as directives are not dependent upon the compilation scope.
        if (directive.isComponent) {
          this.incrementalDriver.trackFileDependencies(deps, dirSf);
        }
      }
      for (const pipe of scope.pipes) {
        // When a pipe in scope is updated, the declaration needs to be recompiled as e.g.
        // the pipe's name may have changed.
        this.incrementalDriver.trackFileDependency(pipe.ref.node.getSourceFile(), file);
      }
    }
    this.perf.stop(recordSpan);
  }
}
