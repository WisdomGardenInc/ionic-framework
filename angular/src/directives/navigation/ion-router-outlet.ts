import { Location } from '@angular/common';
import {
  ComponentFactoryResolver,
  ComponentRef,
  ElementRef,
  Injector,
  NgZone,
  OnDestroy,
  OnInit,
  ViewContainerRef,
  Attribute,
  Directive,
  EventEmitter,
  Optional,
  Output,
  SkipSelf,
  Input,
} from '@angular/core';
import { OutletContext, Router, ActivatedRoute, ChildrenOutletContexts, PRIMARY_OUTLET } from '@angular/router';
import { componentOnReady } from '@ionic/core';
import { Observable, BehaviorSubject } from 'rxjs';
import { distinctUntilChanged, filter, switchMap } from 'rxjs/operators';

import { EnvironmentInjector } from '../../di/r3_injector';
import { AnimationBuilder } from '../../ionic-core';
import { Config } from '../../providers/config';
import { NavController } from '../../providers/nav-controller';
import { isComponentFactoryResolver } from '../../util/util';

import { StackController } from './stack-controller';
import { RouteView, getUrl } from './stack-utils';

// TODO(FW-2827): types

@Directive({
  selector: 'ion-router-outlet',
  exportAs: 'outlet',
  // eslint-disable-next-line @angular-eslint/no-inputs-metadata-property
  inputs: ['animated', 'animation', 'mode', 'swipeGesture'],
})
// eslint-disable-next-line @angular-eslint/directive-class-suffix
export class IonRouterOutlet implements OnDestroy, OnInit {
  nativeEl: HTMLIonRouterOutletElement;

  private activated: ComponentRef<any> | null = null;
  activatedView: RouteView | null = null;

  private _activatedRoute: ActivatedRoute | null = null;
  private _swipeGesture?: boolean;
  private name: string;
  private stackCtrl: StackController;

  // Maintain map of activated route proxies for each component instance
  private proxyMap = new WeakMap<any, ActivatedRoute>();

  // Keep the latest activated route in a subject for the proxy routes to switch map to
  private currentActivatedRoute$ = new BehaviorSubject<{ component: any; activatedRoute: ActivatedRoute } | null>(null);

  tabsPrefix: string | undefined;

  /**
   * @experimental
   *
   * The `EnvironmentInjector` provider instance from the parent component.
   * Required for using standalone components with `ion-router-outlet`.
   *
   * Will be deprecated and removed when Angular 13 support is dropped.
   */
  @Input() environmentInjector: EnvironmentInjector;

  @Output() stackEvents = new EventEmitter<any>();
  // eslint-disable-next-line @angular-eslint/no-output-rename
  @Output('activate') activateEvents = new EventEmitter<any>();
  // eslint-disable-next-line @angular-eslint/no-output-rename
  @Output('deactivate') deactivateEvents = new EventEmitter<any>();

  set animation(animation: AnimationBuilder) {
    this.nativeEl.animation = animation;
  }

  set animated(animated: boolean) {
    this.nativeEl.animated = animated;
  }

  set swipeGesture(swipe: boolean) {
    this._swipeGesture = swipe;

    this.nativeEl.swipeHandler = swipe
      ? {
          canStart: () => this.stackCtrl.canGoBack(1) && !this.stackCtrl.hasRunningTask(),
          onStart: () => this.stackCtrl.startBackTransition(),
          onEnd: (shouldContinue) => this.stackCtrl.endBackTransition(shouldContinue),
        }
      : undefined;
  }

  constructor(
    private parentContexts: ChildrenOutletContexts,
    private location: ViewContainerRef,
    @Attribute('name') name: string,
    @Optional() @Attribute('tabs') tabs: string,
    private config: Config,
    private navCtrl: NavController,
    @Optional() private componentFactoryResolver: ComponentFactoryResolver,
    commonLocation: Location,
    elementRef: ElementRef,
    router: Router,
    zone: NgZone,
    activatedRoute: ActivatedRoute,
    @SkipSelf() @Optional() readonly parentOutlet?: IonRouterOutlet
  ) {
    this.nativeEl = elementRef.nativeElement;
    this.name = name || PRIMARY_OUTLET;
    this.tabsPrefix = tabs === 'true' ? getUrl(router, activatedRoute) : undefined;
    this.stackCtrl = new StackController(this.tabsPrefix, this.nativeEl, router, navCtrl, zone, commonLocation);
    parentContexts.onChildOutletCreated(this.name, this as any);
  }

  ngOnDestroy(): void {
    this.stackCtrl.destroy();
  }

  getContext(): OutletContext | null {
    return this.parentContexts.getContext(this.name);
  }

  ngOnInit(): void {
    if (!this.activated) {
      // If the outlet was not instantiated at the time the route got activated we need to populate
      // the outlet when it is initialized (ie inside a NgIf)
      const context = this.getContext();
      if (context?.route) {
        this.activateWith(context.route, context.resolver || null);
      }
    }

    new Promise((resolve) => componentOnReady(this.nativeEl, resolve)).then(() => {
      if (this._swipeGesture === undefined) {
        this.swipeGesture = this.config.getBoolean('swipeBackEnabled', (this.nativeEl as any).mode === 'ios');
      }
    });
  }

  get isActivated(): boolean {
    return !!this.activated;
  }

  get component(): Record<string, unknown> {
    if (!this.activated) {
      throw new Error('Outlet is not activated');
    }
    return this.activated.instance;
  }

  get activatedRoute(): ActivatedRoute {
    if (!this.activated) {
      throw new Error('Outlet is not activated');
    }
    return this._activatedRoute as ActivatedRoute;
  }

  get activatedRouteData(): any {
    if (this._activatedRoute) {
      return this._activatedRoute.snapshot.data;
    }
    return {};
  }

  /**
   * Called when the `RouteReuseStrategy` instructs to detach the subtree
   */
  detach(): ComponentRef<any> {
    throw new Error('incompatible reuse strategy');
  }

  /**
   * Called when the `RouteReuseStrategy` instructs to re-attach a previously detached subtree
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  attach(_ref: ComponentRef<any>, _activatedRoute: ActivatedRoute): void {
    throw new Error('incompatible reuse strategy');
  }

  deactivate(): void {
    if (this.activated) {
      if (this.activatedView) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const context = this.getContext()!;
        this.activatedView.savedData = new Map(context.children['contexts']);

        /**
         * Angular v11.2.10 introduced a change
         * where this route context is cleared out when
         * a router-outlet is deactivated, However,
         * we need this route information in order to
         * return a user back to the correct tab when
         * leaving and then going back to the tab context.
         */
        const primaryOutlet = this.activatedView.savedData.get('primary');
        if (primaryOutlet && context.route) {
          primaryOutlet.route = { ...context.route };
        }

        /**
         * Ensure we are saving the NavigationExtras
         * data otherwise it will be lost
         */
        this.activatedView.savedExtras = {};
        if (context.route) {
          const contextSnapshot = context.route.snapshot;

          this.activatedView.savedExtras.queryParams = contextSnapshot.queryParams;
          (this.activatedView.savedExtras.fragment as string | null) = contextSnapshot.fragment;
        }
      }
      const c = this.component;
      this.activatedView = null;
      this.activated = null;
      this._activatedRoute = null;
      this.deactivateEvents.emit(c);
    }
  }

  activateWith(
    activatedRoute: ActivatedRoute,
    resolverOrInjector?: ComponentFactoryResolver | EnvironmentInjector | null
  ): void {
    if (this.isActivated) {
      throw new Error('Cannot activate an already activated outlet');
    }
    this._activatedRoute = activatedRoute;

    let cmpRef: any;
    let enteringView = this.stackCtrl.getExistingView(activatedRoute);
    if (enteringView) {
      cmpRef = this.activated = enteringView.ref;
      const saved = enteringView.savedData;
      if (saved) {
        // self-restore
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const context = this.getContext()!;
        context.children['contexts'] = saved;
      }
      // Updated activated route proxy for this component
      this.updateActivatedRouteProxy(cmpRef.instance, activatedRoute);
    } else {
      const snapshot = (activatedRoute as any)._futureSnapshot;

      /**
       * Angular 14 introduces a new `loadComponent` property to the route config.
       * This function will assign a `component` property to the route snapshot.
       * We check for the presence of this property to determine if the route is
       * using standalone components.
       */
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (snapshot.routeConfig!.component == null && this.environmentInjector == null) {
        console.warn(
          '[Ionic Warning]: You must supply an environmentInjector to use standalone components with routing:\n\n' +
            'In your component class, add:\n\n' +
            `   import { EnvironmentInjector } from '@angular/core';\n` +
            '   constructor(public environmentInjector: EnvironmentInjector) {}\n' +
            '\n' +
            'In your router outlet template, add:\n\n' +
            '   <ion-router-outlet [environmentInjector]="environmentInjector"></ion-router-outlet>\n\n' +
            'Alternatively, if you are routing within ion-tabs:\n\n' +
            '   <ion-tabs [environmentInjector]="environmentInjector"></ion-tabs>'
        );
        return;
      }

      const childContexts = this.parentContexts.getOrCreateContext(this.name).children;

      // We create an activated route proxy object that will maintain future updates for this component
      // over its lifecycle in the stack.
      const component$ = new BehaviorSubject<any>(null);
      const activatedRouteProxy = this.createActivatedRouteProxy(component$, activatedRoute);

      const injector = new OutletInjector(activatedRouteProxy, childContexts, this.location.injector);

      /**
       * The resolver is not always provided and is required in Angular 12.
       * Fallback to the class-level provider when the resolver is not set.
       */
      resolverOrInjector = resolverOrInjector || this.componentFactoryResolver;

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const component = snapshot.routeConfig!.component ?? snapshot.component;

      if (resolverOrInjector && isComponentFactoryResolver(resolverOrInjector)) {
        // Backwards compatibility for Angular 13 and lower
        const factory = resolverOrInjector.resolveComponentFactory(component);
        cmpRef = this.activated = this.location.createComponent(factory, this.location.length, injector);
      } else {
        /**
         * Angular 14 and higher.
         *
         * TODO: FW-1641: Migrate once Angular 13 support is dropped.
         *
         * When we drop < Angular 14, we can replace the following code with:
         * ```ts
          const environmentInjector = resolverOrInjector ?? this.environmentInjector;
            cmpRef = this.activated = location.createComponent(component, {
              index: location.length,
              injector,
              environmentInjector,
            });
         * ```
         * where `this.environmentInjector` is a provider of `EnvironmentInjector` from @angular/core.
         */
        const environmentInjector = resolverOrInjector ?? this.environmentInjector;
        cmpRef = this.activated = this.location.createComponent(component, {
          index: this.location.length,
          injector,
          environmentInjector,
        } as any);
      }
      // Once the component is created we can push it to our local subject supplied to the proxy
      component$.next(cmpRef.instance);

      // Calling `markForCheck` to make sure we will run the change detection when the
      // `RouterOutlet` is inside a `ChangeDetectionStrategy.OnPush` component.
      enteringView = this.stackCtrl.createView(this.activated, activatedRoute);

      // Store references to the proxy by component
      this.proxyMap.set(cmpRef.instance, activatedRouteProxy);
      this.currentActivatedRoute$.next({ component: cmpRef.instance, activatedRoute });
    }

    this.activatedView = enteringView;

    /**
     * The top outlet is set prior to the entering view's transition completing,
     * so that when we have nested outlets (e.g. ion-tabs inside an ion-router-outlet),
     * the tabs outlet will be assigned as the top outlet when a view inside tabs is
     * activated.
     *
     * In this scenario, activeWith is called for both the tabs and the root router outlet.
     * To avoid a race condition, we assign the top outlet synchronously.
     */
    this.navCtrl.setTopOutlet(this);

    this.stackCtrl.setActive(enteringView).then((data) => {
      this.activateEvents.emit(cmpRef.instance);
      this.stackEvents.emit(data);
    });
  }

  /**
   * Returns `true` if there are pages in the stack to go back.
   */
  canGoBack(deep = 1, stackId?: string): boolean {
    return this.stackCtrl.canGoBack(deep, stackId);
  }

  /**
   * Resolves to `true` if it the outlet was able to sucessfully pop the last N pages.
   */
  pop(deep = 1, stackId?: string): Promise<boolean> {
    return this.stackCtrl.pop(deep, stackId);
  }

  /**
   * Returns the URL of the active page of each stack.
   */
  getLastUrl(stackId?: string): string | undefined {
    const active = this.stackCtrl.getLastUrl(stackId);
    return active ? active.url : undefined;
  }

  /**
   * Returns the RouteView of the active page of each stack.
   * @internal
   */
  getLastRouteView(stackId?: string): RouteView | undefined {
    return this.stackCtrl.getLastUrl(stackId);
  }

  /**
   * Returns the root view in the tab stack.
   * @internal
   */
  getRootView(stackId?: string): RouteView | undefined {
    return this.stackCtrl.getRootUrl(stackId);
  }

  /**
   * Returns the active stack ID. In the context of ion-tabs, it means the active tab.
   */
  getActiveStackId(): string | undefined {
    return this.stackCtrl.getActiveStackId();
  }

  /**
   * Since the activated route can change over the life time of a component in an ion router outlet, we create
   * a proxy so that we can update the values over time as a user navigates back to components already in the stack.
   */
  private createActivatedRouteProxy(component$: Observable<any>, activatedRoute: ActivatedRoute): ActivatedRoute {
    const proxy: any = new ActivatedRoute();

    proxy._futureSnapshot = (activatedRoute as any)._futureSnapshot;
    proxy._routerState = (activatedRoute as any)._routerState;
    proxy.snapshot = activatedRoute.snapshot;
    proxy.outlet = activatedRoute.outlet;
    proxy.component = activatedRoute.component;

    // Setup wrappers for the observables so consumers don't have to worry about switching to new observables as the state updates
    (proxy as any)._paramMap = this.proxyObservable(component$, 'paramMap');
    (proxy as any)._queryParamMap = this.proxyObservable(component$, 'queryParamMap');
    proxy.url = this.proxyObservable(component$, 'url');
    proxy.params = this.proxyObservable(component$, 'params');
    proxy.queryParams = this.proxyObservable(component$, 'queryParams');
    proxy.fragment = this.proxyObservable(component$, 'fragment');
    proxy.data = this.proxyObservable(component$, 'data');

    return proxy as ActivatedRoute;
  }

  /**
   * Create a wrapped observable that will switch to the latest activated route matched by the given component
   */
  private proxyObservable(component$: Observable<any>, path: string): Observable<any> {
    return component$.pipe(
      // First wait until the component instance is pushed
      filter((component) => !!component),
      switchMap((component) =>
        this.currentActivatedRoute$.pipe(
          filter((current) => current !== null && current.component === component),
          switchMap((current) => current && (current.activatedRoute as any)[path]),
          distinctUntilChanged()
        )
      )
    );
  }

  /**
   * Updates the activated route proxy for the given component to the new incoming router state
   */
  private updateActivatedRouteProxy(component: any, activatedRoute: ActivatedRoute): void {
    const proxy = this.proxyMap.get(component);
    if (!proxy) {
      throw new Error(`Could not find activated route proxy for view`);
    }

    (proxy as any)._futureSnapshot = (activatedRoute as any)._futureSnapshot;
    (proxy as any)._routerState = (activatedRoute as any)._routerState;
    proxy.snapshot = activatedRoute.snapshot;
    proxy.outlet = activatedRoute.outlet;
    proxy.component = activatedRoute.component;

    this.currentActivatedRoute$.next({ component, activatedRoute });
  }
}

class OutletInjector implements Injector {
  constructor(private route: ActivatedRoute, private childContexts: ChildrenOutletContexts, private parent: Injector) {}

  get(token: any, notFoundValue?: any): any {
    if (token === ActivatedRoute) {
      return this.route;
    }

    if (token === ChildrenOutletContexts) {
      return this.childContexts;
    }

    return this.parent.get(token, notFoundValue);
  }
}
