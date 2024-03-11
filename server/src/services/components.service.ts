import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Component } from 'src/entities/component.entity';
import { Layout } from 'src/entities/layout.entity';
import { Page } from 'src/entities/page.entity';
import { dbTransactionForAppVersionAssociationsUpdate, dbTransactionWrap } from 'src/helpers/utils.helper';

import { EventsService } from './events_handler.service';
import { LayoutData } from '@dto/component.dto';

const _ = require('lodash');

@Injectable()
export class ComponentsService {
  constructor(
    private eventHandlerService: EventsService,

    @InjectRepository(Component)
    private componentsRepository: Repository<Component>
  ) {}

  async findOne(id: string): Promise<Component> {
    return this.componentsRepository.findOne(id);
  }

  async create(componentDiff: object, pageId: string, appVersionId: string) {
    return dbTransactionForAppVersionAssociationsUpdate(async (manager: EntityManager) => {
      const page = await manager.findOne(Page, {
        where: { appVersionId, id: pageId },
      });

      const newComponents = this.transformComponentData(componentDiff);

      const componentLayouts = [];

      newComponents.forEach((component) => {
        component.page = page;
      });

      const savedComponents = await manager.save(Component, newComponents);

      savedComponents.forEach((component) => {
        const componentLayout = componentDiff[component.id].layouts;

        if (componentLayout) {
          for (const type in componentLayout) {
            const layout = componentLayout[type];
            const newLayout = new Layout();
            newLayout.type = type;
            newLayout.top = layout.top;
            newLayout.left = layout.left;
            newLayout.width = layout.width;
            newLayout.height = layout.height;
            newLayout.component = component;

            componentLayouts.push(newLayout);
          }
        }
      });

      await manager.save(Layout, componentLayouts);

      return {};
    }, appVersionId);
  }

  async update(componentDiff: object, appVersionId: string) {
    return dbTransactionForAppVersionAssociationsUpdate(async (manager) => {
      for (const componentId in componentDiff) {
        const { component } = componentDiff[componentId];

        const componentData: Component = await manager.findOne(Component, componentId);

        if (!componentData) {
          return {
            error: {
              message: `Component with id ${componentId} does not exist`,
            },
          };
        }

        const isComponentDefinitionChanged = component.definition ? true : false;

        if (isComponentDefinitionChanged) {
          const updatedDefinition = component.definition;
          const columnsUpdated = Object.keys(updatedDefinition);

          const newComponentsData = columnsUpdated.reduce((acc, column) => {
            const newColumnData = _.mergeWith(
              componentData[column === 'others' ? 'displayPreferences' : column],
              updatedDefinition[column],
              (objValue, srcValue) => {
                if (componentData.type === 'Table' && _.isArray(objValue)) {
                  return srcValue;
                }
              }
            );

            if (column === 'others') {
              acc['displayPreferences'] = newColumnData;
            } else {
              acc[column] = newColumnData;
            }

            return acc;
          }, {});

          await manager.update(Component, componentId, newComponentsData);
          return;
        }

        await manager.update(Component, componentId, component);

        return;
      }
    }, appVersionId);
  }

  async delete(componentIds: string[], appVersionId: string, isComponentCut = false) {
    return dbTransactionForAppVersionAssociationsUpdate(async (manager: EntityManager) => {
      const components = await manager.findByIds(Component, componentIds);

      if (!components.length) {
        return {
          error: {
            message: `Components with ids ${componentIds} do not exist`,
          },
        };
      }

      if (!isComponentCut) {
        components.forEach((component) => {
          this.eventHandlerService.cascadeDeleteEvents(component.id);
        });
      }

      await manager.delete(Component, componentIds);
    }, appVersionId);
  }

  async componentLayoutChange(
    componenstLayoutDiff: Record<string, { layouts: LayoutData; component?: { parent: string } }>,
    appVersionId: string
  ) {
    return dbTransactionForAppVersionAssociationsUpdate(async (manager: EntityManager) => {
      for (const componentId in componenstLayoutDiff) {
        const doesComponentExist = await manager.findAndCount(Component, { id: componentId });

        if (!doesComponentExist[1]) {
          return {
            error: {
              message: `Component with id ${componentId} does not exist`,
            },
          };
        }

        const { layouts, component } = componenstLayoutDiff[componentId];

        for (const type in layouts) {
          const componentLayout = await manager.findOne(Layout, { componentId, type });

          if (componentLayout) {
            const layout = {
              ...layouts[type],
            } as Partial<Layout>;

            await manager.update(Layout, { id: componentLayout.id }, layout);
          }
          if (component) {
            await manager.update(Component, { id: componentId }, { parent: component.parent });
          }
        }
      }
    }, appVersionId);
  }

  async getAllComponents(pageId: string) {
    // need to get all components for a page with their layouts

    return dbTransactionWrap(async (manager: EntityManager) => {
      return manager
        .createQueryBuilder(Component, 'component')
        .leftJoinAndSelect('component.layouts', 'layout')
        .where('component.pageId = :pageId', { pageId })
        .getMany()
        .then((components) => {
          return components.reduce((acc, component) => {
            const componentId = component.id;
            const componentData = component;
            const componentLayout = component.layouts;

            const transformedData = this.createComponentWithLayout(componentData, componentLayout);

            acc[componentId] = transformedData[componentId];

            return acc;
          }, {});
        });
    });
  }

  transformComponentData(data: object): Component[] {
    const transformedComponents: Component[] = [];

    for (const componentId in data) {
      const componentData = data[componentId];

      const transformedComponent: Component = new Component();
      transformedComponent.id = componentId;
      transformedComponent.name = componentData.name;
      transformedComponent.type = componentData.type;
      transformedComponent.parent = componentData.parent || null;
      transformedComponent.properties = componentData.properties || {};
      transformedComponent.styles = componentData.styles || {};
      transformedComponent.validation = componentData.validation || {};
      transformedComponent.displayPreferences = componentData.others || null;
      transformedComponent.general = componentData.general || null;
      transformedComponent.generalStyles = componentData.generalStyles || null;

      transformedComponents.push(transformedComponent);
    }

    return transformedComponents;
  }

  createComponentWithLayout(componentData: Component, layoutData = [], manager: EntityManager) {
    const { id, name, properties, styles, generalStyles, validation, parent, displayPreferences, general } =
      componentData;

    const layouts = {};

    layoutData.forEach((layout) => {
      const { type, top, left, width, height, dimensionUnit, id } = layout;

      let adjustedLeftValue = left;
      if (dimensionUnit === 'percent') {
        adjustedLeftValue = resolveGridPositionForComponent(left, type);
        manager.update(
          Layout,
          {
            id,
          },
          {
            dimensionUnit: 'count',
            left: adjustedLeftValue,
          }
        );
      }

      layouts[type] = {
        top,
        left: adjustedLeftValue,
        width,
        height,
      };
    });

    const componentWithLayout = {
      [id]: {
        component: {
          name,
          component: componentData.type,
          definition: {
            properties,
            styles,
            generalStyles,
            validation,
            general,
            others: displayPreferences,
          },
          parent,
        },
        layouts: {
          ...layouts,
        },
      },
    };

    return componentWithLayout;
  }
}

function resolveGridPositionForComponent(dimension: number, type: string) {
  // const numberOfGrids = type === 'desktop' ? 43 : 12;
  const numberOfGrids = 43;
  return Math.round((dimension * numberOfGrids) / 100);
}
