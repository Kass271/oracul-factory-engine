import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { routes } from '../app.routes';

// @trace FR-1
describe('Todos page', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('lists todos from the API', async () => {
    const harness = await RouterTestingHarness.create('/todos');
    TestBed.inject(HttpTestingController)
      .expectOne((r) => r.method === 'GET' && r.url.endsWith('/api/todos'))
      .flush([{ id: 1, title: 'Buy milk', done: false }]);
    await harness.fixture.whenStable();

    expect(harness.routeNativeElement?.textContent).toContain('Buy milk');
  });

  it('adds a todo', async () => {
    const harness = await RouterTestingHarness.create('/todos');
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((r) => r.method === 'GET').flush([]);
    await harness.fixture.whenStable();

    const el = harness.routeNativeElement as HTMLElement;
    const input = el.querySelector('[data-testid="todo-title"]') as HTMLInputElement;
    input.value = 'Write tests';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('[data-testid="todo-add"]') as HTMLButtonElement).click();

    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/api/todos'));
    expect(post.request.body).toEqual({ title: 'Write tests' });
    post.flush({ id: 2, title: 'Write tests', done: false });
    await harness.fixture.whenStable();

    expect(el.textContent).toContain('Write tests');
  });
});
